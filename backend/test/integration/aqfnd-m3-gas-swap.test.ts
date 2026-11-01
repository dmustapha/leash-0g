import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
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
import { buildGasSwapCalls, buildWrappedNativeUnwrap, ruleKey, type CallRule, type GrantState } from '../../src/governed-call/index.js';
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

const HOME = 84532;
const OWNER = '0x' + '4b'.repeat(20);
const BENEFICIARY = '0x' + '9c'.repeat(20);
const TOKEN = '0x' + 'ec'.repeat(20); // the settlement token == the goal token (USDC-like, 6dp)
const ROUTER = '0x' + 'dd'.repeat(20);
const WETH = '0x' + 'ee'.repeat(20);
const OPS = '0x' + '0f'.repeat(20);
const SESSION_PK = '0x' + '6d'.repeat(32);
const SESSION_ADDR = '0x' + 'cb'.repeat(20);
const CAP = 10n ** 16n;
const SALE = 5_000_000n; // gasSwap.tokenAmount: 5 USDC
const WETH_OUT = 2n * 10n ** 15n; // what the fake pool pays for the sale (== the refuel dust)
const LOW_NATIVE = 5n * 10n ** 14n; // >= swap+refuel leg gas (4.6e14), below the refill trigger (7.6e14)

const SEL_APPROVE = toFunctionSelector('function approve(address,uint256)').toLowerCase();
const SEL_SWAP = '0x04e45aaf';
const SEL_WITHDRAW = '0x2e1a7d4d';

const HOME_CONFIG: ChainConfig = {
  chainId: HOME,
  name: 'Base Sepolia',
  rpcUrl: 'http://unused.invalid',
  registryAddr: '0x' + '00'.repeat(20),
  accountVersion: 6,
  gasFloorWei: 0n, // Base has no static floor
  canonical: { router: ROUTER, settlementToken: TOKEN },
  gasSwap: { wrappedNative: WETH, dexFeeTier: 3000, tokenAmount: SALE },
};


interface RecordedCall {
  target: string;
  value: bigint;
  data: string;
}

function rule(target: string, selector: string, over: Partial<CallRule> = {}): CallRule {
  return { target, selector, recipientMode: 'self', spenderSet: [], perCallCap: '20000000', windowCapCall: '100000000', ...over };
}

function fullGrants(): GrantState {
  const rules = [
    rule(TOKEN, SEL_APPROVE, { spenderSet: [ROUTER] }),
    rule(ROUTER, SEL_SWAP),
    rule(WETH, SEL_WITHDRAW, { perCallCap: '1000000000000000000' }),
  ];
  return {
    rules: new Map(rules.map((r) => [ruleKey(r.target, r.selector), r])),
    budgets: new Map([[TOKEN, '100000000']]),
    allowlist: new Set<string>(),
  };
}

class FakeRuntimeChain implements RuntimeChain {
  public balances = new Map<string, bigint>();
  public tokenTransfers: Array<{ token: string; to: string; amountWei: bigint }> = [];
  /** every executeCall ATTEMPT, in order (a reverting call is recorded then throws) */
  public calls: RecordedCall[] = [];
  public accountAddr = '';
  public accountToken = 10n * 10n ** 6n; // 10 USDC
  public accountWeth = 0n;
  public grants: GrantState = fullGrants();
  /** make the executeCall whose target equals this address revert */
  public revertTarget: string | null = null;
  public policyView: PolicyView = {
    perTransferCap: CAP,
    windowCap: 3n * CAP,
    windowSeconds: 3600,
    expiresAt: Math.floor(Date.now() / 1000) + 86_400,
    allowlist: [BENEFICIARY],
    revoked: false,
    spentInWindow: 0n,
    windowStart: Math.floor(Date.now() / 1000),
  };

  async getBalance(addr: string): Promise<bigint> {
    return this.balances.get(addr.toLowerCase()) ?? 0n;
  }
  async getPolicyView(): Promise<PolicyView> {
    return this.policyView;
  }
  async getErc20Balance(token: string, owner: string): Promise<bigint> {
    if (owner.toLowerCase() !== this.accountAddr.toLowerCase()) return 0n;
    return token.toLowerCase() === WETH ? this.accountWeth : this.accountToken;
  }
  async getAssetPolicy(_acct: string, token: string, payeeCandidates: string[]) {
    const isNative = token.toLowerCase() === '0x0000000000000000000000000000000000000000';
    const payees = isNative ? [SESSION_ADDR] : [BENEFICIARY, OPS];
    const set = new Set(payees.map((p) => p.toLowerCase()));
    return { enabled: true, allowedPayees: payeeCandidates.map((p) => p.toLowerCase()).filter((p) => set.has(p)) };
  }
  /** every session-key native transfer (account.execute(to, value, '0x')) - the refuel leg */
  public nativeTransfers: Array<{ to: string; valueWei: bigint }> = [];
  async executeTransfer(input: { to: string; valueWei: bigint }): Promise<{ txHash: string }> {
    this.nativeTransfers.push({ to: input.to.toLowerCase(), valueWei: input.valueWei });
    if (input.to.toLowerCase() === SESSION_ADDR.toLowerCase()) {
      this.balances.set(SESSION_ADDR.toLowerCase(), (this.balances.get(SESSION_ADDR.toLowerCase()) ?? 0n) + input.valueWei);
    }
    return { txHash: '0x' + 'ee'.repeat(32) };
  }
  async executeTokenTransfer(input: { token: string; to: string; amountWei: bigint }): Promise<{ txHash: string }> {
    this.tokenTransfers.push({ token: input.token, to: input.to, amountWei: input.amountWei });
    return { txHash: '0x' + 'dd'.repeat(32) };
  }
  async executeCall(input: { target: string; valueWei: bigint; data: string }): Promise<{ txHash: string }> {
    const target = input.target.toLowerCase();
    this.calls.push({ target, value: input.valueWei, data: input.data });
    // The real account refuses executeCall(target == itself) with SelfCallForbidden; the fake must too,
    // or a self-targeted refuel passes here and reverts live (the Tier B finding).
    if (target === this.accountAddr.toLowerCase()) throw new Error('SelfCallForbidden');
    if (this.revertTarget && target === this.revertTarget) throw new Error('execution reverted: swap failed');
    this.applyEffect(target);
    return { txHash: '0x' + String(this.calls.length).padStart(2, '0').repeat(32) };
  }
  /** model just enough of the chain that later legs and the next cycle see the earlier legs' effects */
  private applyEffect(target: string): void {
    if (target === ROUTER) {
      this.accountToken -= SALE;
      this.accountWeth += WETH_OUT;
    } else if (target === WETH) {
      this.balances.set(this.accountAddr.toLowerCase(), this.accountWeth);
      this.accountWeth = 0n;
    }
  }
  async getErc20Allowance(): Promise<bigint> {
    return 0n;
  }
  async getSwapBandPrice18(): Promise<bigint | null> {
    return null;
  }
  async getErc20Meta(): Promise<{ symbol: string; decimals: number }> {
    return { symbol: 'USDC', decimals: 6 };
  }
  async readCallGrantState(): Promise<GrantState> {
    return this.grants;
  }
}

type FakeRegistry = Pick<ChainRegistry, 'has' | 'getChainConfig' | 'getSessionChain'>;

let db: TestDb;
let t: TestApp;
let server: Server;
let gatewayUrl: string;
let checkpointer: PostgresSaver;
let fakeChain: FakeRuntimeChain;
let manager: LeashRuntimeManager;
const startedAgents: string[] = [];

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

beforeEach(() => {
  fakeChain = new FakeRuntimeChain();
  const registry: FakeRegistry = {
    has: (id) => id === HOME,
    getChainConfig: () => HOME_CONFIG,
    getSessionChain: () => fakeChain,
  };
  manager = new LeashRuntimeManager({
    pool: db.pool,
    hub: t.hub,
    broker: t.broker,
    chain: fakeChain,
    chainRegistry: registry as ChainRegistry,
    checkpointer,
    alerts: t.alerts,
    settings: {
      keyring: TEST_KEYRING,
      approvalTimeoutMs: 20_000,
      gatewayUrl,
      intervalMs: 3_600_000,
      defaultModel: 'test-model',
      jitTtlMs: 600_000,
    },
  });
});

afterEach(async () => {
  for (const id of startedAgents.splice(0)) await manager.stop(id);
  nock.cleanAll();
});

afterAll(async () => {
  nock.enableNetConnect();
  await new Promise((resolve) => server.close(resolve));
  await db.drop();
});

async function seedGasAgent(opts: { sessionNative: bigint }): Promise<string> {
  const gen = generateGatewayToken();
  const account = `0x${randomBytes(20).toString('hex')}`;
  fakeChain.accountAddr = account;
  fakeChain.balances.set(SESSION_ADDR.toLowerCase(), opts.sessionNative);
  const id = await seedAgent(db.pool, {
    ownerAddr: OWNER,
    chainId: HOME,
    accountAddr: account,
    sessionKeyAddr: SESSION_ADDR,
    tokenId: gen.tokenId,
    tokenHash: await hashTokenSecret(gen.secret),
    sessionKeyEnc: encryptSecret(SESSION_PK, TEST_KEYRING),
    gatewayTokenEnc: encryptSecret(gen.token, TEST_KEYRING),
    goal: {
      type: 'treasury',
      beneficiary: BENEFICIARY,
      token: TOKEN,
      targetBalanceWei: (50n * CAP).toString(),
      topUpWei: (CAP / 2n).toString(),
      model: 'test-model',
    },
  });
  return id;
}

function mockSend(): void {
  nock(UPSTREAM)
    .post('/v1/chat/completions')
    .reply(200, {
      id: 'c',
      choices: [
        { message: { role: 'assistant', content: JSON.stringify({ action: 'send', amountWei: (CAP / 2n).toString(), reason: 'token top-up' }) } },
      ],
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

describe('AQ-FND M-3 inc-3a — swap-to-gas executor through the governed wall', () => {
  it('(a) all legs granted: exactly 3 executeCalls + 1 native refuel transfer, in order with the exact calldata, ONE trace, then has-native', async () => {
    const id = await seedGasAgent({ sessionNative: LOW_NATIVE });
    await runOneCycle(id);

    const { approve, swap } = buildGasSwapCalls({
      self: fakeChain.accountAddr as `0x${string}`,
      token: TOKEN as `0x${string}`,
      router: ROUTER as `0x${string}`,
      wrappedNative: WETH as `0x${string}`,
      feeTier: 3000,
      amountIn: SALE,
    });
    const unwrap = buildWrappedNativeUnwrap(WETH as `0x${string}`, WETH_OUT);

    expect(fakeChain.calls).toEqual([
      { target: TOKEN, value: 0n, data: approve.data },
      { target: ROUTER, value: 0n, data: swap.data },
      { target: WETH, value: 0n, data: unwrap.data },
    ]);
    // the refuel is a DIRECT session-key native transfer (account.execute), never an executeCall to self
    expect(fakeChain.nativeTransfers).toEqual([{ to: SESSION_ADDR.toLowerCase(), valueWei: WETH_OUT }]);
    expect(fakeChain.tokenTransfers).toHaveLength(0); // the cycle stands down on buying gas

    const traces = await listTraces(db.pool, id);
    const actions = traces.filter((r) => r.kind === 'action');
    expect(actions).toHaveLength(1);
    expect(String((actions[0]?.detail as Record<string, unknown>)['summary'])).toContain('bought gas: swapped 5000000 units');
    expect(await listRecentRequests(db.pool, id)).toHaveLength(0);

    // NEXT cycle re-plans: the key now holds native => has-native => the plain token top-up.
    mockSend();
    manager.nudge(id);
    await waitFor(() => fakeChain.tokenTransfers.length > 0);
    await manager.settle(id);
    expect(fakeChain.calls).toHaveLength(3); // no second swap
    expect(fakeChain.nativeTransfers).toHaveLength(1);
    expect(fakeChain.tokenTransfers[0]?.to.toLowerCase()).toBe(BENEFICIARY.toLowerCase());
  });

  it('(b) router rule missing: exactly ONE capability request for the swap leg, NO executeCall', async () => {
    fakeChain.grants = fullGrants();
    fakeChain.grants.rules.delete(ruleKey(ROUTER, SEL_SWAP));
    const id = await seedGasAgent({ sessionNative: LOW_NATIVE });
    await runOneCycle(id);

    expect(fakeChain.calls).toHaveLength(0);
    const requests = await listRecentRequests(db.pool, id);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.status).toBe('pending');
    expect((requests[0]?.decoded as Record<string, unknown>)['selector']).toBe(SEL_SWAP);
    expect(requests[0]?.novelty).toContain('new_target');

    // a second cycle raises no duplicate (deduped by callHash)
    mockSend();
    manager.nudge(id);
    await waitFor(async () => (await listTraces(db.pool, id)).filter((r) => r.kind === 'decision').length >= 2);
    await manager.settle(id);
    expect(await listRecentRequests(db.pool, id)).toHaveLength(1);
    expect(fakeChain.calls).toHaveLength(0);
  });

  it('(c) zero native is NOT swap-to-gas: the planner asks once, nothing is submitted', async () => {
    const id = await seedGasAgent({ sessionNative: 0n });
    await runOneCycle(id);

    expect(fakeChain.calls).toHaveLength(0);
    expect(fakeChain.tokenTransfers).toHaveLength(0);
    const { alerts } = await listAlerts(db.pool, OWNER, { kind: 'gas_request', agentId: id });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.dedupKey).toBe(`gas_request:${id}:${HOME}:ask-owner`);
    expect(await listRecentRequests(db.pool, id)).toHaveLength(0);
  });

  it('(d) a reverting leg: failed outcome with the leg named, no further legs, no loop', async () => {
    fakeChain.revertTarget = ROUTER;
    const id = await seedGasAgent({ sessionNative: LOW_NATIVE });
    await runOneCycle(id);

    // approve landed, the swap attempt reverted, unwrap + refuel never ran
    expect(fakeChain.calls.map((c) => c.target)).toEqual([TOKEN, ROUTER]);
    const traces = await listTraces(db.pool, id);
    expect(traces.filter((r) => r.kind === 'action')).toHaveLength(0);
    const failed = traces.find((r) => r.kind === 'decision');
    expect(String((failed?.detail as Record<string, unknown>)['summary'])).toContain('swap-to-gas swap leg failed');

    await new Promise((r) => setTimeout(r, 500)); // nothing re-submits by itself
    expect(fakeChain.calls).toHaveLength(2);
  });

  it('(e) a low-native agent with a spendable token swaps for gas and raises no gas_request', async () => {
    const id = await seedGasAgent({ sessionNative: LOW_NATIVE });
    await runOneCycle(id);

    expect(fakeChain.calls.map((c) => c.target)).toEqual([TOKEN, ROUTER, WETH]);
    expect(fakeChain.nativeTransfers.map((t) => t.to)).toEqual([SESSION_ADDR.toLowerCase()]);
    const { alerts } = await listAlerts(db.pool, OWNER, { kind: 'gas_request', agentId: id });
    expect(alerts).toHaveLength(0);
  });
});
