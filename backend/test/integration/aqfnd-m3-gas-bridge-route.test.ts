import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import nock from 'nock';
import { toFunctionSelector } from 'viem';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { buildTestApp, TEST_KEYRING, UPSTREAM, type TestApp } from '../helpers/app.js';
import { generateGatewayToken, hashTokenSecret } from '../../src/crypto/token.js';
import { encryptSecret } from '../../src/crypto/keycrypt.js';
import { listTraces } from '../../src/trace/trace-store.js';
import { listAlerts } from '../../src/alerts/store.js';
import { listRecentRequests } from '../../src/store/capabilities.js';
import { LeashRuntimeManager } from '../../src/runtime/manager.js';
import { buildCctpBurnCalls, ruleKey, type CallRule, type GrantState } from '../../src/governed-call/index.js';
import { listRailTransfersForAgent } from '../../src/store/rail-transfers.js';
import { insertChainDeployment } from '../../src/store/chain-deployments.js';

import type { ChainConfig, ChainRegistry } from '../../src/chain/registry.js';
import type { RuntimeChain } from '../../src/runtime/session-chain.js';
import type { PolicyView } from '../../src/types.js';

/**
 * AQ-FND M-3 inc-3a — the swap-to-gas EXECUTOR through the governed wall. A low-but-nonzero
 * session key on a DEX chain, holding a spendable token:
 *  (a) every leg granted (L1) => exactly 3 executeCall [approve, swap, withdraw] + 1 direct native refuel transfer, with the
 *      exact calldata, ONE action trace, and the NEXT cycle re-plans has-native;
 *  (b) router rule missing => ONE capability request for the swap leg, NO executeCall;
 *  (c) zero native => unchanged (not swap-to-gas): one gas_request ask;
 *  (d) a reverting leg => failed outcome, no further legs, no loop;
 *  (e) there is no relayer: swap-to-gas is the only self-funding rung with a token on a DEX chain.
 */

/**
 * AQ-FND M-3 inc-3b S3b — bridge-then-swap through the REAL manager + graph. The agent's HOME chain
 * (Base, a DEX chain) has ZERO native and no token; the SAME-ADDRESS account on Arbitrum holds USDC and
 * the session key has gas there. Expected:
 *  (a) all source-chain grants L1 + the bridge-gate passes: exactly [approve, burn] on the ARB chain, ONE
 *      open `cctp` rail row (ops_fill plan, burn hash write-ahead), ONE action trace, nothing on Base;
 *  (b) while that transfer is open the next cycle waits - no second burn;
 *  (c) a missing burn rule => ONE gas_request ask naming the burn step, no calls, no row;
 *  (d) a bridge-gate refusal => ONE ask, no calls, no row;
 *  (e) CCTP fill not enabled (no MessageTransmitter) => the planner never picks the bridge: ONE ask-owner.
 */

const HOME = 84532;
const ARB = 421614;
const OWNER = '0x' + '4b'.repeat(20);
const BENEFICIARY = '0x' + '9c'.repeat(20);
const HOME_USDC = '0x' + 'ec'.repeat(20);
const ARB_USDC = '0x' + 'ed'.repeat(20);
const ROUTER = '0x' + 'dd'.repeat(20);
const WETH = '0x' + 'ee'.repeat(20);
const MESSENGER = '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa';
const SESSION_PK = '0x' + '6d'.repeat(32);
const SESSION_ADDR = '0x' + 'cb'.repeat(20);
const CAP = 10n ** 16n;
const SALE = 5_000_000n;
const ARB_NATIVE = 10n ** 16n; // the key has gas on Arb for the burn
const SEL_APPROVE = toFunctionSelector('function approve(address,uint256)').toLowerCase();
const SEL_BURN = '0x8e0250ee';

const cfg = (chainId: number, name: string, extra: Partial<ChainConfig>): ChainConfig => ({
  chainId, name, rpcUrl: 'http://unused.invalid', registryAddr: '0x' + '00'.repeat(20), accountVersion: 6, gasFloorWei: 0n, ...extra,
});
const HOME_CONFIG = cfg(HOME, 'Base Sepolia', {
  canonical: { router: ROUTER, settlementToken: HOME_USDC },
  gasSwap: { wrappedNative: WETH, dexFeeTier: 3000, tokenAmount: SALE },
  bridgeAllowlist: [MESSENGER],
  cctpTokenMessenger: MESSENGER,
});
const ARB_CONFIG = cfg(ARB, 'Arbitrum Sepolia', {
  canonical: { settlementToken: ARB_USDC },
  bridgeAllowlist: [MESSENGER],
  cctpTokenMessenger: MESSENGER,
  cctpUsdc: ARB_USDC,
});

function rule(target: string, selector: string, over: Partial<CallRule> = {}): CallRule {
  return { target, selector, recipientMode: 'self', spenderSet: [], perCallCap: '20000000', windowCapCall: '100000000', ...over };
}
function arbGrants(): GrantState {
  const rules = [rule(ARB_USDC, SEL_APPROVE, { spenderSet: [MESSENGER] }), rule(MESSENGER, SEL_BURN)];
  return { rules: new Map(rules.map((r) => [ruleKey(r.target, r.selector), r])), budgets: new Map([[ARB_USDC, '100000000']]), allowlist: new Set<string>() };
}

class FakeChain implements RuntimeChain {
  balances = new Map<string, bigint>();
  accountAddr = '';
  accountToken = 0n;
  /** S1 test hook: throw this from the burn call (e.g. an unconfirmed receipt) AFTER the burn executed */
  burnError: Error | null = null;
  grants: GrantState = arbGrants();
  allowance = 0n;
  calls: Array<{ target: string; value: bigint; data: string }> = [];
  tokenTransfers: Array<{ token: string; to: string; amountWei: bigint }> = [];
  nativeTransfers: Array<{ to: string; valueWei: bigint }> = [];
  policyView: PolicyView = {
    perTransferCap: CAP, windowCap: 3n * CAP, windowSeconds: 3600, expiresAt: Math.floor(Date.now() / 1000) + 86_400,
    allowlist: [BENEFICIARY], revoked: false, spentInWindow: 0n, windowStart: Math.floor(Date.now() / 1000),
  };
  constructor(readonly token: string) {}
  async getBalance(addr: string): Promise<bigint> { return this.balances.get(addr.toLowerCase()) ?? 0n; }
  async getPolicyView(): Promise<PolicyView> { return this.policyView; }
  async getErc20Balance(token: string, owner: string): Promise<bigint> {
    return owner.toLowerCase() === this.accountAddr.toLowerCase() && token.toLowerCase() === this.token ? this.accountToken : 0n;
  }
  async getAssetPolicy(_a: string, token: string, payees: string[]) {
    const native = token.toLowerCase() === '0x0000000000000000000000000000000000000000';
    return { enabled: true, allowedPayees: native ? [] : payees.map((p) => p.toLowerCase()) };
  }
  async executeTransfer(input: { to: string; valueWei: bigint }): Promise<{ txHash: string }> { this.nativeTransfers.push({ to: input.to, valueWei: input.valueWei }); return { txHash: '0x' + 'ee'.repeat(32) }; }
  async executeTokenTransfer(input: { token: string; to: string; amountWei: bigint }): Promise<{ txHash: string }> { this.tokenTransfers.push(input); return { txHash: '0x' + 'dd'.repeat(32) }; }
  /** enforces the real refusals: SelfCall, burn needs allowance + balance */
  async executeCall(input: { target: string; valueWei: bigint; data: string }): Promise<{ txHash: string }> {
    const target = input.target.toLowerCase();
    this.calls.push({ target, value: input.valueWei, data: input.data });
    if (target === this.accountAddr.toLowerCase()) throw new Error('SelfCallForbidden');
    if (target === this.token) {
      this.allowance = BigInt('0x' + input.data.slice(10 + 64, 10 + 128));
      return { txHash: '0x' + 'a1'.repeat(32) };
    }
    if (target === MESSENGER) {
      const amount = BigInt('0x' + input.data.slice(10, 10 + 64));
      if (this.allowance < amount) throw new Error('ERC20: insufficient allowance');
      if (this.accountToken < amount) throw new Error('ERC20: burn amount exceeds balance');
      this.accountToken -= amount;
      this.allowance -= amount;
      if (this.burnError) throw this.burnError;
      return { txHash: '0x' + 'b2'.repeat(32) };
    }
    throw new Error(`unexpected target ${target}`);
  }
  async getErc20Allowance(): Promise<bigint> { return 0n; }
  async getSwapBandPrice18(): Promise<bigint | null> { return null; }
  async getErc20Meta(): Promise<{ symbol: string; decimals: number }> { return { symbol: 'USDC', decimals: 6 }; }
  async readCallGrantState(): Promise<GrantState> { return this.grants; }
}

let db: TestDb;
let t: TestApp;
let server: Server;
let gatewayUrl: string;
let checkpointer: PostgresSaver;
let homeChain: FakeChain;
let arbChain: FakeChain;
let gateRefuses = false;
let manager: LeashRuntimeManager;
const startedAgents: string[] = [];
type FakeRegistry = Pick<ChainRegistry, 'has' | 'getChainConfig' | 'getSessionChain'>;

beforeAll(async () => {
  db = await createTestDb();
  checkpointer = new PostgresSaver(db.pool, undefined, { schema: db.schema });
  await checkpointer.setup();
  t = buildTestApp(db.pool);
  server = t.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no server address');
  gatewayUrl = `http://127.0.0.1:${addr.port}`;
  nock.disableNetConnect();
  nock.enableNetConnect(/127\.0\.0\.1|localhost|neon\.tech/);
});

function buildManager(opts: { cctpFillEnabled: boolean }): void {
  homeChain = new FakeChain(HOME_USDC);
  arbChain = new FakeChain(ARB_USDC);
  gateRefuses = false;
  const registry: FakeRegistry = {
    has: (id) => id === HOME || id === ARB,
    getChainConfig: (id) => (id === ARB ? ARB_CONFIG : HOME_CONFIG),
    getSessionChain: (id) => (id === ARB ? arbChain : homeChain),
  };
  manager = new LeashRuntimeManager({
    pool: db.pool, hub: t.hub, broker: t.broker, chain: homeChain, chainRegistry: registry as ChainRegistry, checkpointer, alerts: t.alerts,
    // the real bridge-gate needs a full registry + persisted tuple; its own tests cover it - here it is a switch
    bridgeGate: (async () => {
      if (gateRefuses) throw new Error('bridge routing REFUSED (same_address_refused): test');
      return { destinationChainId: HOME, verifiedAddr: '0x' };
    }),
    settings: { keyring: TEST_KEYRING, approvalTimeoutMs: 20_000, gatewayUrl, intervalMs: 3_600_000, defaultModel: 'test-model', jitTtlMs: 600_000, cctpFillEnabled: opts.cctpFillEnabled },
  });
}

afterEach(async () => {
  for (const id of startedAgents.splice(0)) await manager.stop(id);
  nock.cleanAll();
});
afterAll(async () => {
  nock.enableNetConnect();
  await new Promise((resolve) => server.close(resolve));
  await db.drop();
});

async function seedAgentWithArb(): Promise<string> {
  const gen = generateGatewayToken();
  const account = `0x${randomBytes(20).toString('hex')}`;
  homeChain.accountAddr = account;
  arbChain.accountAddr = account;
  arbChain.accountToken = 12_000_000n; // 12 USDC on Arb
  homeChain.accountToken = 1_000_000_000n; // the account holds the GOAL token at home (S1: code only sends what the account holds)
  arbChain.balances.set(SESSION_ADDR.toLowerCase(), ARB_NATIVE);
  homeChain.balances.set(SESSION_ADDR.toLowerCase(), 0n); // ZERO native on the home chain
  const id = await seedAgent(db.pool, {
    ownerAddr: OWNER, chainId: HOME, accountAddr: account, sessionKeyAddr: SESSION_ADDR,
    tokenId: gen.tokenId, tokenHash: await hashTokenSecret(gen.secret),
    sessionKeyEnc: encryptSecret(SESSION_PK, TEST_KEYRING), gatewayTokenEnc: encryptSecret(gen.token, TEST_KEYRING),
    goal: { type: 'treasury', beneficiary: BENEFICIARY, token: HOME_USDC, targetBalanceWei: (50n * CAP).toString(), topUpWei: (CAP / 2n).toString(), model: 'test-model' },
  });
  await insertChainDeployment(db.pool, { agentId: id, chainId: ARB, accountAddr: account, createTx: '0x1', registerTx: '0x2', chainAgentId: null, adopted: false });
  return id;
}

function mockSend(): void {
  nock(UPSTREAM).post('/v1/chat/completions').reply(200, {
    id: 'c',
    choices: [{ message: { role: 'assistant', content: JSON.stringify({ action: 'send', amountWei: (CAP / 2n).toString(), reason: 'token top-up' }) } }],
    x_0g_trace: { provider: 'p', request_id: 'r', billing: {} },
  });
}
async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}
async function runOneCycle(id: string): Promise<void> {
  mockSend();
  await manager.start(id);
  startedAgents.push(id);
  await waitFor(async () => (await listTraces(db.pool, id)).filter((r) => r.kind === 'decision' || r.kind === 'action').length >= 1);
  await manager.settle(id);
}

describe('AQ-FND M-3 inc-3b S3b — bridge-then-swap source leg through the manager + graph', () => {

  it('(f) Gate-2 M-5: an UNCONFIRMED burn receipt keeps the hash on the rail, does not fail it, and the next cycle does not burn again', async () => {
    buildManager({ cctpFillEnabled: true });
    const id = await seedAgentWithArb();
    const { ReceiptUnconfirmedError } = await import('../../src/chain/wait-receipt.js');
    arbChain.burnError = new ReceiptUnconfirmedError({ hash: ('0x' + 'b2'.repeat(32)) as `0x${string}`, attempts: 4, quirk: true, cause: new Error('no receipt') });
    await runOneCycle(id);
    const rows = await listRailTransfersForAgent(db.pool, id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('initiated'); // NOT failed: the burn may well have mined
    expect(rows[0]?.srcTx).toBe('0x' + 'b2'.repeat(32)); // the handle is kept
    const burnsBefore = arbChain.calls.filter((c) => c.target === MESSENGER).length;
    expect(burnsBefore).toBe(1);
    await manager.settle(id);
    expect(arbChain.calls.filter((c) => c.target === MESSENGER)).toHaveLength(1); // no second burn
    arbChain.burnError = null;
  });
  it('(a) all grants + gate pass: [approve, burn] on the ARB chain only, one open cctp row, one action trace, nothing on Base', async () => {
    buildManager({ cctpFillEnabled: true });
    const id = await seedAgentWithArb();
    await runOneCycle(id);

    const { approve, burn } = buildCctpBurnCalls({
      self: arbChain.accountAddr as `0x${string}`, tokenMessenger: MESSENGER, burnToken: ARB_USDC as `0x${string}`, destinationDomain: 6, amount: SALE,
    });
    expect(arbChain.calls).toEqual([
      { target: ARB_USDC, value: 0n, data: approve.data },
      { target: MESSENGER, value: 0n, data: burn.data },
    ]);
    expect(homeChain.calls).toHaveLength(0);
    expect(homeChain.tokenTransfers).toHaveLength(0);
    expect(arbChain.accountToken).toBe(12_000_000n - SALE);

    const rows = await listRailTransfersForAgent(db.pool, id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rail: 'cctp', status: 'initiated', srcChainId: ARB, destChainId: HOME, amountWei: SALE.toString(), srcTx: '0x' + 'b2'.repeat(32) });
    expect(rows[0]?.destGasPlan).toMatchObject({ source: 'ops_fill' });

    const actions = (await listTraces(db.pool, id)).filter((r) => r.kind === 'action');
    expect(actions).toHaveLength(1);
    expect(String((actions[0]?.detail as Record<string, unknown>)['summary'])).toContain('bridging for gas');
    expect((await listAlerts(db.pool, OWNER, { kind: 'gas_request', agentId: id })).alerts).toHaveLength(0);
  });

  it('(b) while the transfer is open the next cycle waits: no second burn, no ask', async () => {
    buildManager({ cctpFillEnabled: true });
    const id = await seedAgentWithArb();
    await runOneCycle(id);
    expect(arbChain.calls).toHaveLength(2);
    mockSend();
    manager.nudge(id);
    await waitFor(async () => (await listTraces(db.pool, id)).filter((r) => r.kind === 'decision').length >= 1);
    await manager.settle(id);
    expect(arbChain.calls).toHaveLength(2);
    expect(await listRailTransfersForAgent(db.pool, id)).toHaveLength(1);
    expect((await listAlerts(db.pool, OWNER, { kind: 'gas_request', agentId: id })).alerts).toHaveLength(0);
  });

  it('(c) a missing burn rule: ONE gas_request ask naming the burn step, no calls, no rail row', async () => {
    buildManager({ cctpFillEnabled: true });
    arbChain.grants = arbGrants();
    arbChain.grants.rules.delete(ruleKey(MESSENGER, SEL_BURN));
    const id = await seedAgentWithArb();
    await runOneCycle(id);
    expect(arbChain.calls).toHaveLength(0);
    expect(await listRailTransfersForAgent(db.pool, id)).toHaveLength(0);
    const { alerts } = await listAlerts(db.pool, OWNER, { kind: 'gas_request', agentId: id });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.summary).toMatch(/burn step is not covered by the owner's grants on the source chain/);
    expect(await listRecentRequests(db.pool, id)).toHaveLength(0); // never an unusable capability card
  });

  it('(d) a bridge-gate refusal: ONE ask, no calls, no rail row', async () => {
    buildManager({ cctpFillEnabled: true });
    gateRefuses = true;
    const id = await seedAgentWithArb();
    await runOneCycle(id);
    expect(arbChain.calls).toHaveLength(0);
    expect(await listRailTransfersForAgent(db.pool, id)).toHaveLength(0);
    const { alerts } = await listAlerts(db.pool, OWNER, { kind: 'gas_request', agentId: id });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.summary).toMatch(/same_address_refused/);
  });

  it('(e) CCTP fill not enabled (no MessageTransmitter): the planner never bridges - one ask-owner, nothing burned', async () => {
    buildManager({ cctpFillEnabled: false });
    const id = await seedAgentWithArb();
    await runOneCycle(id);
    expect(arbChain.calls).toHaveLength(0);
    expect(await listRailTransfersForAgent(db.pool, id)).toHaveLength(0);
    const { alerts } = await listAlerts(db.pool, OWNER, { kind: 'gas_request', agentId: id });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.dedupKey).toBe(`gas_request:${id}:${HOME}:ask-owner`);
  });
});
