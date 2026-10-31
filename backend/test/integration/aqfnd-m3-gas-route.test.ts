import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import nock from 'nock';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { buildTestApp, TEST_KEYRING, UPSTREAM, type TestApp } from '../helpers/app.js';
import { generateGatewayToken, hashTokenSecret } from '../../src/crypto/token.js';
import { encryptSecret } from '../../src/crypto/keycrypt.js';
import { listTraces } from '../../src/trace/trace-store.js';
import { listAlerts } from '../../src/alerts/store.js';
import { setAllowRelayerBootstrap } from '../../src/store/agents.js';
import { LeashRuntimeManager } from '../../src/runtime/manager.js';
import type { ChainConfig, ChainRegistry } from '../../src/chain/registry.js';
import type { RuntimeChain } from '../../src/runtime/session-chain.js';
import type { GrantState } from '../../src/governed-call/index.js';
import type { PolicyView } from '../../src/types.js';

/**
 * AQ-FND M-3 inc-2 — the planner is wired into the act loop. A zero-native session key with a
 * spendable token:
 *  - opt-in FALSE (the default) ⇒ exactly ONE specific `gas_request`, NO transaction, relayer idle;
 *  - opt-in TRUE  ⇒ the rung-4 relayer bootstrap runs (repaid in token);
 *  - funded key   ⇒ plain token transfer, no alert (unchanged behaviour);
 *  - a second cycle does not raise a duplicate ask.
 */

const HOME = 16602;
const OWNER = '0x' + '4b'.repeat(20);
const BENEFICIARY = '0x' + '9c'.repeat(20);
const TOKEN = '0x' + 'ec'.repeat(20);
const OPS = '0x' + '0f'.repeat(20);
const DELEGATE = '0x' + 'de'.repeat(20);
const SESSION_PK = '0x' + '6d'.repeat(32);
const SESSION_ADDR = '0x' + 'cb'.repeat(20);
const CAP = 10n ** 16n;

const HOME_CONFIG: ChainConfig = {
  chainId: HOME,
  name: '0G Galileo',
  rpcUrl: 'http://unused.invalid',
  registryAddr: '0x' + '00'.repeat(20),
  accountVersion: 6,
  gasFloorWei: 2_000_000_000n,
  gasRepayDelegateAddr: DELEGATE,
};

class FakeRuntimeChain implements RuntimeChain {
  public balances = new Map<string, bigint>();
  public tokenTransfers: Array<{ token: string; to: string; amountWei: bigint }> = [];
  public executeCalls = 0;
  public tokenEnabled = true;
  /** lowercased payees allowlisted for TOKEN (beneficiary + the ops relayer). */
  public tokenPayees: string[] = [BENEFICIARY.toLowerCase(), OPS.toLowerCase()];
  public accountAddr = '';
  /** the ACCOUNT's balance in TOKEN (what the agent can spend / repay with). */
  public accountTokenBalance = 10n ** 18n;
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
  async getErc20Balance(_token: string, owner: string): Promise<bigint> {
    return owner.toLowerCase() === this.accountAddr.toLowerCase() ? this.accountTokenBalance : 0n;
  }
  async getAssetPolicy(_acct: string, token: string, payeeCandidates: string[]) {
    const isNative = token.toLowerCase() === '0x0000000000000000000000000000000000000000';
    const set = new Set(isNative ? [] : this.tokenPayees);
    return {
      enabled: isNative ? true : this.tokenEnabled,
      allowedPayees: payeeCandidates.map((p) => p.toLowerCase()).filter((p) => set.has(p)),
    };
  }
  async executeTransfer(): Promise<{ txHash: string }> {
    return { txHash: '0x' + 'ee'.repeat(32) };
  }
  async executeTokenTransfer(input: { token: string; to: string; amountWei: bigint }): Promise<{ txHash: string }> {
    this.tokenTransfers.push({ token: input.token, to: input.to, amountWei: input.amountWei });
    return { txHash: '0x' + 'dd'.repeat(32) };
  }
  async executeCall(): Promise<{ txHash: string }> {
    this.executeCalls += 1;
    return { txHash: '0x' + 'cc'.repeat(32) };
  }
  async getErc20Allowance(): Promise<bigint> {
    return 0n;
  }
  async getSwapBandPrice18(): Promise<bigint | null> {
    return null;
  }
  async getErc20Meta(): Promise<{ symbol: string; decimals: number }> {
    return { symbol: 'AQB', decimals: 18 };
  }
  async readCallGrantState(): Promise<GrantState> {
    return { rules: new Map(), budgets: new Map(), allowlist: new Set() };
  }
}

/** The rung-4 executor's chain primitives, recorded so a test can prove the relayer fired. */
interface RelayerSpy {
  submitted: Array<{ to: string | undefined; type: string | undefined; hasAuthorization: boolean }>;
}

function fakeBootstrap(spy: RelayerSpy) {
  const opsWallet = {
    account: { address: OPS },
    chain: undefined,
    async sendTransaction(tx: { to?: string; type?: string; authorizationList?: unknown[] }) {
      spy.submitted.push({ to: tx.to, type: tx.type, hasAuthorization: (tx.authorizationList?.length ?? 0) > 0 });
      return '0x' + 'ab'.repeat(32);
    },
  };
  const sessionWallet = {
    account: { address: SESSION_ADDR },
    async signAuthorization() {
      return { chainId: HOME, address: DELEGATE, nonce: 0, r: '0x01', s: '0x02', yParity: 0 };
    },
    async signMessage() {
      return '0x' + '11'.repeat(65);
    },
  };
  return {
    publicClient: { getChainId: async () => HOME },
    opsWallet,
    opsRelayerAddr: OPS,
    delegate: DELEGATE,
    buildSessionWallet: () => sessionWallet,
  };
}

type FakeRegistry = Pick<ChainRegistry, 'has' | 'getChainConfig' | 'getBootstrapGas' | 'getSessionChain' | 'getOpsRelayerAddr'>;

let db: TestDb;
let t: TestApp;
let server: Server;
let gatewayUrl: string;
let checkpointer: PostgresSaver;
let fakeChain: FakeRuntimeChain;
let relayer: RelayerSpy;
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
  relayer = { submitted: [] };
  const registry: FakeRegistry = {
    has: (id) => id === HOME,
    getChainConfig: () => HOME_CONFIG,
    getBootstrapGas: () => fakeBootstrap(relayer) as unknown as ReturnType<ChainRegistry['getBootstrapGas']>,
    getSessionChain: () => fakeChain,
    getOpsRelayerAddr: () => OPS,
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

async function seedGasAgent(opts: { sessionNative: bigint; optIn: boolean }): Promise<string> {
  const gen = generateGatewayToken();
  const account = `0x${randomBytes(20).toString('hex')}`;
  fakeChain.accountAddr = account;
  fakeChain.balances.set(SESSION_ADDR.toLowerCase(), opts.sessionNative);
  const id = await seedAgent(db.pool, {
    ownerAddr: OWNER,
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
  if (opts.optIn) await setAllowRelayerBootstrap(db.pool, id, true);
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

async function runOneCycle(id: string, expectedDecisions: number): Promise<void> {
  mockSend();
  await manager.start(id);
  startedAgents.push(id);
  await waitFor(async () => (await listTraces(db.pool, id)).filter((r) => r.kind === 'decision' || r.kind === 'action').length >= expectedDecisions);
  await manager.settle(id);
}

describe('AQ-FND M-3 inc-2 — gas route wired into the act loop', () => {
  it('(a) zero native + opt-in FALSE ⇒ exactly ONE specific gas_request, no tx, relayer never fires', async () => {
    const id = await seedGasAgent({ sessionNative: 0n, optIn: false });
    await runOneCycle(id, 1);

    expect(relayer.submitted).toHaveLength(0); // the relayer is NOT the default
    expect(fakeChain.tokenTransfers).toHaveLength(0);
    expect(fakeChain.executeCalls).toBe(0);
    const { alerts } = await listAlerts(db.pool, OWNER, { kind: 'gas_request', agentId: id });
    expect(alerts).toHaveLength(1);
    const alert = alerts[0]!;
    expect(alert.dedupKey).toBe(`gas_request:${id}:${HOME}:ask-owner`);
    expect(alert.summary).toContain('0G Galileo');
    expect(alert.summary).toContain('owner opt-in for relayer bootstrap');
    expect(alert.summary).not.toMatch(/\d+ wei/);
  });

  it('(b) zero native + opt-in TRUE ⇒ the rung-4 relayer bootstrap is invoked, no alert', async () => {
    const id = await seedGasAgent({ sessionNative: 0n, optIn: true });
    await runOneCycle(id, 1);
    await waitFor(() => relayer.submitted.length > 0);

    expect(relayer.submitted[0]).toMatchObject({ to: SESSION_ADDR, type: 'eip7702', hasAuthorization: true });
    expect(fakeChain.tokenTransfers).toHaveLength(0); // the top-up rides inside the relayed batch
    const { alerts } = await listAlerts(db.pool, OWNER, { kind: 'gas_request', agentId: id });
    expect(alerts).toHaveLength(0);
  });

  it('(c) funded session key ⇒ plain token transfer, no alert, relayer idle', async () => {
    const id = await seedGasAgent({ sessionNative: 10n ** 16n, optIn: false });
    await runOneCycle(id, 1);
    await waitFor(() => fakeChain.tokenTransfers.length > 0);

    expect(fakeChain.tokenTransfers).toHaveLength(1);
    expect(fakeChain.tokenTransfers[0]!.to.toLowerCase()).toBe(BENEFICIARY.toLowerCase());
    expect(relayer.submitted).toHaveLength(0);
    const { alerts } = await listAlerts(db.pool, OWNER, { kind: 'gas_request', agentId: id });
    expect(alerts).toHaveLength(0);
  });

  it('(d) a second cycle does not raise a duplicate ask', async () => {
    const id = await seedGasAgent({ sessionNative: 0n, optIn: false });
    await runOneCycle(id, 1);
    mockSend();
    manager.nudge(id);
    await waitFor(async () => (await listTraces(db.pool, id)).filter((r) => r.kind === 'decision').length >= 2);
    await manager.settle(id);

    const { alerts } = await listAlerts(db.pool, OWNER, { kind: 'gas_request', agentId: id });
    expect(alerts).toHaveLength(1);
    expect(relayer.submitted).toHaveLength(0);
  });

  it('an owner opt-in flipped while the agent runs takes effect on the next cycle (no restart)', async () => {
    const id = await seedGasAgent({ sessionNative: 0n, optIn: false });
    await runOneCycle(id, 1);
    expect(relayer.submitted).toHaveLength(0);

    await setAllowRelayerBootstrap(db.pool, id, true);
    mockSend();
    manager.nudge(id);
    await waitFor(() => relayer.submitted.length > 0);
    await manager.settle(id);
    expect(relayer.submitted[0]).toMatchObject({ type: 'eip7702' });
  });
});
