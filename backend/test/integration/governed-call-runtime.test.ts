import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import nock from 'nock';
import { decodeAbiParameters, encodeErrorResult, getAddress } from 'viem';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { buildTestApp, TEST_KEYRING, UPSTREAM, type TestApp } from '../helpers/app.js';
import { generateGatewayToken, hashTokenSecret } from '../../src/crypto/token.js';
import { encryptSecret } from '../../src/crypto/keycrypt.js';
import { listTraces } from '../../src/trace/trace-store.js';
import { listAlerts } from '../../src/alerts/store.js';
import { LeashRuntimeManager } from '../../src/runtime/manager.js';
import { leashAccountV4Abi } from '../../src/chain/abis.js';
import { upsertGrant, listRecentRequests } from '../../src/store/capabilities.js';
import type { RuntimeChain, GrantStateCandidates } from '../../src/runtime/session-chain.js';
import type { CallRule, GrantState } from '../../src/governed-call/index.js';
import type { PolicyView } from '../../src/types.js';

/**
 * Stage D (D-10): the runtime generic governed-call decide-node. An agent emits a
 * `call` intent → the decide node builds the calldata from LIVE grant state
 * (never-guess-money) → classifies against that envelope → L1 acts silently, L2
 * raises a quarantined JIT request (never a doomed submit), unbuildable stands down.
 */

const OWNER = '0x' + '4b'.repeat(20);
const BENEFICIARY = '0x' + '9c'.repeat(20);
const ACCOUNT = '0x' + 'c2'.repeat(20);
const SESSION_PK = '0x' + '6d'.repeat(32);
const TOKEN = '0x' + 'a1'.repeat(20);
const SPENDER = '0x' + 'b2'.repeat(20);
const OTHER = '0x' + 'e5'.repeat(20);
const APPROVE = '0x095ea7b3';
const CAP = 10n ** 16n;
const PER_CALL_CAP = '1000';

function grantedRule(spenders: string[] = [SPENDER]): CallRule {
  return {
    target: TOKEN,
    selector: APPROVE,
    recipientMode: 'self',
    spenderSet: spenders,
    perCallCap: PER_CALL_CAP,
    windowCapCall: '5000',
  };
}

class FakeRuntimeChain implements RuntimeChain {
  public balances = new Map<string, bigint>([[ACCOUNT.toLowerCase(), 10n ** 18n]]);
  public calls: Array<{ target: string; valueWei: bigint; data: string }> = [];
  public grantState: GrantState = { rules: new Map(), budgets: new Map(), allowlist: new Set() };
  public lastCandidates: GrantStateCandidates | null = null;
  public failNextCall: string | null = null;
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
  async executeTransfer(): Promise<{ txHash: string }> {
    return { txHash: '0x' + 'ee'.repeat(32) };
  }
  async executeTokenTransfer(): Promise<{ txHash: string }> {
    return { txHash: '0x' + 'dd'.repeat(32) };
  }
  async executeCall(input: { target: string; valueWei: bigint; data: string }): Promise<{ txHash: string }> {
    if (this.failNextCall) {
      const m = this.failNextCall;
      this.failNextCall = null;
      throw new Error(m);
    }
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
  async readCallGrantState(c: GrantStateCandidates): Promise<GrantState> {
    this.lastCandidates = c;
    return this.grantState;
  }
}

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

async function seedRuntimeAgent(): Promise<string> {
  const gen = generateGatewayToken();
  // SE-6 pre-req: UNIQUE(owner_addr, chain_id, account_addr) — fresh account
  // address per seeded agent, funded in the fake chain (like a real factory).
  const account = `0x${randomBytes(20).toString('hex')}`;
  fakeChain.balances.set(account.toLowerCase(), 10n ** 18n);
  return seedAgent(db.pool, {
    ownerAddr: OWNER,
    accountAddr: account,
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
}

/** Seed the read-model grant so the capability envelope lists it in the prompt. */
async function seedGrant(agentId: string, rule: CallRule = grantedRule()): Promise<void> {
  await upsertGrant(db.pool, { agentId, ownerAddr: OWNER, rule, source: 'preset:defi_trader', status: 'active' });
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

async function start(agentId: string): Promise<void> {
  await manager.start(agentId);
  startedAgents.push(agentId);
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('runtime generic governed-call action (D-10)', () => {
  it('L1 in-envelope: builds calldata from grant state, submits executeCall silently, traces it', async () => {
    const id = await seedRuntimeAgent();
    await seedGrant(id);
    fakeChain.grantState = {
      rules: new Map([[`${TOKEN}:${APPROVE}`, grantedRule()]]),
      budgets: new Map([[TOKEN, '5000']]),
      allowlist: new Set(),
    };
    mockModelDecision(JSON.stringify({ action: 'call', target: TOKEN, selector: APPROVE, amountWei: '100', reason: 'approve router for a swap' }));

    await start(id);
    await waitFor(() => fakeChain.calls.length === 1);
    await manager.settle(id);

    const c = fakeChain.calls[0];
    if (!c) throw new Error('expected a governed call');
    expect(c.target).toBe(TOKEN);
    expect(c.data.startsWith(APPROVE)).toBe(true);
    // never-guess-money: the SPENDER is pinned from grant state, the amount from the model.
    const [spender, amount] = decodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }],
      ('0x' + c.data.slice(10)) as `0x${string}`,
    );
    expect(getAddress(spender as string)).toBe(getAddress(SPENDER));
    expect(amount).toBe(100n);

    // The candidate set the runtime live-read was enumerated from the read-model.
    expect(fakeChain.lastCandidates?.rules[0]?.target).toBe(TOKEN);

    const traces = await listTraces(db.pool, id);
    const action = traces.find((r) => r.kind === 'action');
    expect(action).toBeTruthy();
    expect(String((action?.detail as Record<string, unknown>)?.['summary'])).toContain('governed call to');
  });

  it('L2 novel (over per-call cap): raises exactly one quarantined JIT request, no submit', async () => {
    const id = await seedRuntimeAgent();
    await seedGrant(id);
    fakeChain.grantState = {
      rules: new Map([[`${TOKEN}:${APPROVE}`, grantedRule()]]),
      budgets: new Map([[TOKEN, '5000']]),
      allowlist: new Set(),
    };
    // amount 2000 > perCallCap 1000 → buildable but classified L2 (over_cap).
    mockModelDecision(JSON.stringify({ action: 'call', target: TOKEN, selector: APPROVE, amountWei: '2000', reason: 'approve a large amount' }));

    await start(id);
    await waitFor(async () => (await listRecentRequests(db.pool, id)).length === 1);
    await manager.settle(id);

    expect(fakeChain.calls).toHaveLength(0); // never a doomed submit (P3C-6)
    const [req] = await listRecentRequests(db.pool, id);
    expect(req?.status).toBe('pending');
    expect(req?.novelty).toContain('over_cap');
    // quarantined + labeled, never trusted/executed
    expect((req?.decoded as Record<string, unknown>)?.['label']).toBe('UNVERIFIED');

    const { alerts } = await listAlerts(db.pool, OWNER, { kind: 'capability_request' });
    expect(alerts.length).toBeGreaterThanOrEqual(1);
  });

  it('never-guess-money: an ungranted target is refused (stand down), not built or submitted', async () => {
    const id = await seedRuntimeAgent();
    await seedGrant(id);
    fakeChain.grantState = {
      rules: new Map([[`${TOKEN}:${APPROVE}`, grantedRule()]]),
      budgets: new Map([[TOKEN, '5000']]),
      allowlist: new Set(),
    };
    mockModelDecision(JSON.stringify({ action: 'call', target: OTHER, selector: APPROVE, amountWei: '100', reason: 'approve an unknown target' }));

    await start(id);
    await waitFor(async () => (await listTraces(db.pool, id)).some((r) => r.kind === 'decision'));
    await manager.settle(id);

    expect(fakeChain.calls).toHaveLength(0);
    expect(await listRecentRequests(db.pool, id)).toHaveLength(0); // no grant → no request, just stand down
    const traces = await listTraces(db.pool, id);
    const decision = traces.find((r) => r.kind === 'decision');
    expect(String((decision?.detail as Record<string, unknown>)?.['summary'])).toContain('not authority-determined');
  });

  it('never-guess-money: an ambiguous spender (>1) is refused rather than guessed', async () => {
    const id = await seedRuntimeAgent();
    const twoSpenders = grantedRule([SPENDER, OTHER]);
    await seedGrant(id, twoSpenders);
    fakeChain.grantState = {
      rules: new Map([[`${TOKEN}:${APPROVE}`, twoSpenders]]),
      budgets: new Map([[TOKEN, '5000']]),
      allowlist: new Set(),
    };
    mockModelDecision(JSON.stringify({ action: 'call', target: TOKEN, selector: APPROVE, amountWei: '100', reason: 'approve someone' }));

    await start(id);
    await waitFor(async () => (await listTraces(db.pool, id)).some((r) => r.kind === 'decision'));
    await manager.settle(id);

    expect(fakeChain.calls).toHaveLength(0);
    expect(await listRecentRequests(db.pool, id)).toHaveLength(0);
  });

  it('a governed call revert on-chain is recorded as failed, never as a completed action', async () => {
    const id = await seedRuntimeAgent();
    await seedGrant(id);
    fakeChain.grantState = {
      rules: new Map([[`${TOKEN}:${APPROVE}`, grantedRule()]]),
      budgets: new Map([[TOKEN, '5000']]),
      allowlist: new Set(),
    };
    const revert = encodeErrorResult({ abi: leashAccountV4Abi.filter((i) => i.type === 'error'), errorName: 'OverCallWindowCap', args: [2000n, 1000n] });
    fakeChain.failNextCall = `execution reverted: ${revert}`;
    mockModelDecision(JSON.stringify({ action: 'call', target: TOKEN, selector: APPROVE, amountWei: '100', reason: 'approve' }));

    await start(id);
    await waitFor(async () => (await listTraces(db.pool, id)).some((r) => r.kind === 'decision'));
    await manager.settle(id);

    const traces = await listTraces(db.pool, id);
    expect(traces.some((r) => r.kind === 'action')).toBe(false); // a revert is never an action
    const decision = traces.find((r) => r.kind === 'decision');
    expect(String((decision?.detail as Record<string, unknown>)?.['summary'])).toContain('governed call refused');
  });
});
