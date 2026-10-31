import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import nock from 'nock';
import { decodeAbiParameters, getAddress, toFunctionSelector } from 'viem';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { buildTestApp, TEST_KEYRING, UPSTREAM, type TestApp } from '../helpers/app.js';
import { generateGatewayToken, hashTokenSecret } from '../../src/crypto/token.js';
import { encryptSecret } from '../../src/crypto/keycrypt.js';
import { listTraces } from '../../src/trace/trace-store.js';
import { LeashRuntimeManager } from '../../src/runtime/manager.js';
import { upsertGrant } from '../../src/store/capabilities.js';
import { UnregisteredChainError, type ChainRegistry } from '../../src/chain/registry.js';
import type { LeashChainOps } from '../../src/chain/ops.js';
import type { RuntimeChain, GrantStateCandidates } from '../../src/runtime/session-chain.js';
import type { CallRule, GrantState } from '../../src/governed-call/index.js';
import type { PolicyView } from '../../src/types.js';

/**
 * SE-8 (E-9) — the runtime governed-bridging lane, end-to-end through the
 * treasury graph: an in-envelope bridge intent passes the HARD pre-routing gate
 * (assertSameAddress on home + destination, carry #1) and submits `executeCall`;
 * a same-address refusal STANDS DOWN (no submit, traced); no bridge lane / an
 * off-allowlist bridge is forbidden (BR-2 default-DENY, carry #2).
 */

const OWNER = '0x' + '4b'.repeat(20);
const BENEFICIARY = '0x' + '9c'.repeat(20);
const SESSION_PK = '0x' + '6d'.repeat(32);
const BRIDGE = '0x4200000000000000000000000000000000000010';
const SEL_BRIDGE_ETH_TO = toFunctionSelector('function bridgeETHTo(address,uint32,bytes)').toLowerCase();
const CAP = 10n ** 16n;
const HOME_CHAIN = 16602;
const DEST_CHAIN = 11155111;

function bridgeRule(): CallRule {
  return {
    target: BRIDGE,
    selector: SEL_BRIDGE_ETH_TO,
    recipientMode: 'self',
    spenderSet: [],
    perCallCap: '1000',
    windowCapCall: '5000',
  };
}

class FakeRuntimeChain implements RuntimeChain {
  public balances = new Map<string, bigint>();
  public calls: Array<{ target: string; valueWei: bigint; data: string }> = [];
  public grantState: GrantState = { rules: new Map(), budgets: new Map(), allowlist: new Set() };
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
    return this.balances.get(addr.toLowerCase()) ?? 10n ** 18n;
  }
  async getPolicyView(): Promise<PolicyView> {
    return this.policyView;
  }
  async executeTransfer(): Promise<{ txHash: string }> {
    return { txHash: '0x' + 'ee'.repeat(32) };
  }
  async executeTokenTransfer(): Promise<{ txHash: string }> {
    return { txHash: '0x' + 'dd'.repeat(32) };
  }
  async executeCall(input: { target: string; valueWei: bigint; data: string }): Promise<{ txHash: string }> {
    this.calls.push({ target: input.target, valueWei: input.valueWei, data: input.data });
    return { txHash: '0x' + 'cc'.repeat(32) };
  }
  async getErc20Balance(): Promise<bigint> {
    return 0n;
  }
  async getErc20Allowance(): Promise<bigint> {
    return 0n;
  }
  async getSwapBandPrice18(): Promise<bigint | null> {
    return null;
  }
  async getErc20Meta(): Promise<{ symbol: string; decimals: number }> {
    return { symbol: '0G', decimals: 18 };
  }
  async readCallGrantState(_c: GrantStateCandidates): Promise<GrantState> {
    return this.grantState;
  }
}

const TUPLE = {
  ownerAddr: OWNER,
  guardianAddr: '0x' + '02'.repeat(20),
  sessionKeyAddr: '0x' + '03'.repeat(20),
  policy: { perTransferCap: '100', windowCap: '300', windowSeconds: 3600, expiresAt: 2000000000 },
  allowlist: [] as string[],
  timelockDelay: 0,
  settlementToken: '0x0000000000000000000000000000000000000000',
  tokenPolicy: { perTransferCapToken: '0', windowCapToken: '0' },
};

let db: TestDb;
let t: TestApp;
let server: Server;
let gatewayUrl: string;
let checkpointer: PostgresSaver;
let fakeChain: FakeRuntimeChain;
let manager: LeashRuntimeManager;
let sameAddressMock: ReturnType<typeof vi.fn>;
const startedAgents: string[] = [];

// Typed partial — only the registry surface the bridge lane actually exercises.
// Typing against `Pick<ChainRegistry, …>` (instead of `as unknown as ChainRegistry`)
// makes tsc validate each mocked member's signature against the real interface, so
// future drift (e.g. SE-9's added `getChainOps` destination cross-check) fails the
// build instead of surfacing only as a runtime "is not a function" at test time.
type FakeChainRegistry = Pick<
  ChainRegistry,
  'has' | 'getChainConfig' | 'getChainOps' | 'assertSameAddress' | 'getBootstrapGas' | 'getOpsRelayerAddr' | 'getSessionChain'
>;

function fakeRegistry(): ChainRegistry {
  const fake: FakeChainRegistry = {
    has: (id: number) => id === HOME_CHAIN || id === DEST_CHAIN,
    getChainConfig: (id: number) => {
      if (id === HOME_CHAIN) {
        return {
          chainId: HOME_CHAIN,
          bridgeAllowlist: [BRIDGE],
          bridgeDestinations: { [BRIDGE]: DEST_CHAIN },
        } as unknown as ReturnType<ChainRegistry['getChainConfig']>;
      }
      if (id === DEST_CHAIN) return { chainId: DEST_CHAIN } as unknown as ReturnType<ChainRegistry['getChainConfig']>;
      throw new UnregisteredChainError(id);
    },
    // SE-9 L-02: bridge-gate cross-checks the destination RPC's self-reported
    // chain id — the fake ops lane reports its own id so the happy path passes.
    getChainOps: (id: number) => ({ getChainId: async () => id }) as unknown as LeashChainOps,
    assertSameAddress: sameAddressMock,
    // AQ-FND M-3: `gasDeps()` (every cycle) asks the registry for the 7702 bootstrap primitives
    // and the multi-chain gas-route surface. This bridge lane has no GasRepayDelegate, so the
    // bootstrap is unavailable (null) and the route resolver is the same fake chain.
    getBootstrapGas: () => null,
    getOpsRelayerAddr: () => '0x00000000000000000000000000000000000000a5',
    getSessionChain: () => fakeChain,
  };
  return fake as ChainRegistry;
}

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
  sameAddressMock = vi.fn();
  manager = new LeashRuntimeManager({
    pool: db.pool,
    hub: t.hub,
    broker: t.broker,
    chain: fakeChain,
    chainRegistry: fakeRegistry(),
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

async function seedBridgeAgent(opts: { tuple?: boolean } = {}): Promise<{ id: string; account: string }> {
  const gen = generateGatewayToken();
  const account = `0x${randomBytes(20).toString('hex')}`;
  const id = await seedAgent(db.pool, {
    ownerAddr: OWNER,
    accountAddr: account,
    chainId: HOME_CHAIN,
    tokenId: gen.tokenId,
    tokenHash: await hashTokenSecret(gen.secret),
    sessionKeyEnc: encryptSecret(SESSION_PK, TEST_KEYRING),
    gatewayTokenEnc: encryptSecret(gen.token, TEST_KEYRING),
    goal: {
      beneficiary: BENEFICIARY,
      targetBalanceWei: (50n * CAP).toString(),
      topUpWei: (CAP / 2n).toString(),
      model: 'test-model',
    },
  });
  await db.pool.query(
    `UPDATE agents SET account_version = 4, account_salt = $2, account_create_tuple = $3 WHERE id = $1`,
    [id, '0x' + randomBytes(32).toString('hex'), opts.tuple === false ? null : JSON.stringify(TUPLE)],
  );
  await upsertGrant(db.pool, { agentId: id, ownerAddr: OWNER, rule: bridgeRule(), source: 'custom', status: 'active' });
  fakeChain.grantState = {
    rules: new Map([[`${BRIDGE}:${SEL_BRIDGE_ETH_TO}`, bridgeRule()]]),
    budgets: new Map([['0x0000000000000000000000000000000000000000', '5000']]),
    allowlist: new Set(),
  };
  return { id, account };
}

function mockModelDecision(content: string): void {
  nock(UPSTREAM)
    .post('/v1/chat/completions')
    .reply(200, {
      id: 'cmpl-r',
      choices: [{ message: { role: 'assistant', content } }],
      x_0g_trace: { provider: '0xprov', request_id: 'req-r', billing: { total: 1 } },
    });
}

const bridgeDecision = JSON.stringify({
  action: 'call',
  target: BRIDGE,
  selector: SEL_BRIDGE_ETH_TO,
  amountWei: '500',
  reason: 'bridge treasury float to the far-chain account',
});

async function start(id: string): Promise<void> {
  await manager.start(id);
  startedAgents.push(id);
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function lastStandDownReason(id: string): Promise<string> {
  const traces = await listTraces(db.pool, id);
  const dec = traces.filter((r) => r.kind === 'decision').at(-1);
  const summary = (dec?.detail as Record<string, unknown> | undefined)?.['summary'];
  return typeof summary === 'string' ? summary : '';
}

describe('SE-8 runtime governed bridging (E-9)', () => {
  it('L1 in-cap bridge to SELF passes the pre-routing gate and submits executeCall (value = amount)', async () => {
    const { id, account } = await seedBridgeAgent();
    sameAddressMock.mockResolvedValue(account);
    mockModelDecision(bridgeDecision);

    await start(id);
    await waitFor(() => fakeChain.calls.length === 1);
    await manager.settle(id);

    const c = fakeChain.calls[0];
    if (!c) throw new Error('expected a bridge call');
    expect(c.target.toLowerCase()).toBe(BRIDGE);
    expect(c.valueWei).toBe(500n); // the bridged amount rides as msg.value
    expect(c.data.startsWith(SEL_BRIDGE_ETH_TO)).toBe(true);
    // never-guess-money: the recipient is the agent's OWN account (same-address pin)
    const [to] = decodeAbiParameters(
      [{ type: 'address' }, { type: 'uint32' }, { type: 'bytes' }],
      ('0x' + c.data.slice(10)) as `0x${string}`,
    );
    expect(getAddress(to as string)).toBe(getAddress(account));

    // carry #1: the gate ran in its FULL shape before the submit
    expect(sameAddressMock).toHaveBeenCalledTimes(1);
    const gateCall = sameAddressMock.mock.calls[0]?.[0];
    expect(gateCall.expectedAccountAddr.toLowerCase()).toBe(account.toLowerCase());
    expect(gateCall.homeChainId).toBe(HOME_CHAIN);
    expect(gateCall.chainIds).toEqual([HOME_CHAIN, DEST_CHAIN]);
  });

  it('a same-address REFUSAL stands down — no submit, the refusal is traced', async () => {
    const { id } = await seedBridgeAgent();
    sameAddressMock.mockRejectedValue(new Error('same-address verification REFUSED at chain 11155111'));
    mockModelDecision(bridgeDecision);

    await start(id);
    await waitFor(async () => (await lastStandDownReason(id)).includes('pre-routing gate'));
    await manager.settle(id);

    expect(fakeChain.calls.length).toBe(0);
    expect(await lastStandDownReason(id)).toContain('bridge call refused by the pre-routing gate');
  });

  it('a tuple-less agent cannot bridge (no deterministic same-address to verify) — no submit', async () => {
    const { id } = await seedBridgeAgent({ tuple: false });
    sameAddressMock.mockResolvedValue('0xnever');
    mockModelDecision(bridgeDecision);

    await start(id);
    await waitFor(async () => (await lastStandDownReason(id)).includes('pre-routing gate'));
    await manager.settle(id);

    expect(fakeChain.calls.length).toBe(0);
    expect(sameAddressMock).not.toHaveBeenCalled(); // refused BEFORE any RPC verification
    expect(await lastStandDownReason(id)).toContain('no_persisted_tuple');
  });

  it('without a bridge lane (no registry) a bridge call is forbidden (BR-2 fail-closed) — no submit', async () => {
    // a manager with NO chainRegistry: bridgeTargets never reach the grant state
    manager = new LeashRuntimeManager({
      pool: db.pool,
      hub: t.hub,
      broker: t.broker,
      chain: fakeChain,
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
    const { id } = await seedBridgeAgent();
    mockModelDecision(bridgeDecision);

    await start(id);
    await waitFor(async () => (await lastStandDownReason(id)).includes('forbidden'));
    await manager.settle(id);

    expect(fakeChain.calls.length).toBe(0);
    expect(await lastStandDownReason(id)).toContain('bridge_not_allowlisted');
  });
});
