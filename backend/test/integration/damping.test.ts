import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { Server } from 'node:http';
import nock from 'nock';
import { encodeErrorResult } from 'viem';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { buildTestApp, TEST_KEK, UPSTREAM, type TestApp } from '../helpers/app.js';
import { generateGatewayToken, hashTokenSecret } from '../../src/crypto/token.js';
import { encryptSecret } from '../../src/crypto/keycrypt.js';
import { listTraces } from '../../src/trace/trace-store.js';
import { listAlerts, getAlert } from '../../src/alerts/store.js';
import { LeashRuntimeManager } from '../../src/runtime/manager.js';
import { leashAccountAbi } from '../../src/chain/abis.js';
import type { RuntimeChain } from '../../src/runtime/session-chain.js';
import type { PolicyView } from '../../src/types.js';

/**
 * P3C-6 (D6 + D8): window observability feeds the runtime, and a policy
 * boundary produces EXACTLY ONE limit_hit decision alert + zero futile act
 * attempts across cycles — resuming when the boundary clears.
 */

const OWNER = '0x' + '4b'.repeat(20);
const BENEFICIARY = '0x' + '9c'.repeat(20);
const ACCOUNT = '0x' + 'c2'.repeat(20);
const SESSION_PK = '0x' + '6d'.repeat(32);
const CAP = 10n ** 16n;

const errorAbi = leashAccountAbi.filter((i) => i.type === 'error');
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- tsc needs the widening; eslint's project service disagrees
const OVER_WINDOW_REVERT = encodeErrorResult({
  abi: errorAbi,
  errorName: 'OverWindowCap',
  args: [4n * CAP, 3n * CAP],
} as unknown as Parameters<typeof encodeErrorResult>[0]);

class FakeRuntimeChain implements RuntimeChain {
  public balances = new Map<string, bigint>([[ACCOUNT, 10n ** 18n]]);
  public executed: Array<{ to: string; valueWei: bigint }> = [];
  public revertAllExecutes = false;
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
    return this.balances.get(addr.toLowerCase()) ?? this.balances.get(addr) ?? 0n;
  }

  async getPolicyView(): Promise<PolicyView> {
    return this.policyView;
  }

  async executeTransfer(input: { to: string; valueWei: bigint }): Promise<{ txHash: string }> {
    if (this.revertAllExecutes) {
      throw new Error(`execution reverted: ${OVER_WINDOW_REVERT}`);
    }
    this.executed.push({ to: input.to, valueWei: input.valueWei });
    return { txHash: '0x' + 'ee'.repeat(32) };
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
      keyEncryptionSecret: TEST_KEK,
      approvalTimeoutMs: 20_000,
      gatewayUrl,
      intervalMs: 3_600_000, // one cycle per start; further cycles via nudge()
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

async function seedRuntimeAgent(): Promise<string> {
  const gen = generateGatewayToken();
  return seedAgent(db.pool, {
    ownerAddr: OWNER,
    accountAddr: ACCOUNT,
    tokenId: gen.tokenId,
    tokenHash: await hashTokenSecret(gen.secret),
    sessionKeyEnc: encryptSecret(SESSION_PK, TEST_KEK),
    gatewayTokenEnc: encryptSecret(gen.token, TEST_KEK),
    goal: {
      beneficiary: BENEFICIARY,
      targetBalanceWei: (50n * CAP).toString(),
      topUpWei: (CAP / 2n).toString(),
      model: 'test-model',
    },
  });
}

function mockModelDecision(content: string, times = 1): void {
  nock(UPSTREAM)
    .post('/v1/chat/completions')
    .times(times)
    .reply(200, {
      id: 'cmpl-r',
      choices: [{ message: { role: 'assistant', content } }],
      x_0g_trace: { provider: '0xprov', request_id: 'req-r', billing: { total: 1 } },
    });
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function runOneCycle(id: string): Promise<void> {
  // The in-flight cycle must FINISH first (nudge() is a no-op while busy),
  // and settle() alone can't detect the nudged cycle — it may await the OLD
  // promise. A cycle provably ran when the trace chain grew (every cycle
  // appends at least the gateway inference trace).
  await manager.settle(id);
  const before = (await listTraces(db.pool, id)).length;
  manager.nudge(id);
  await waitFor(async () => (await listTraces(db.pool, id)).length > before);
  await manager.settle(id);
}

const SEND = JSON.stringify({ action: 'send', amountWei: (CAP / 2n).toString(), reason: 'top-up' });

describe('D6 — window observability reaches the model', () => {
  it('the reason request carries spentInWindowWei / remainingWindowWei / windowResetsAtUnix with rollover math', async () => {
    const id = await seedRuntimeAgent();
    // Window half-spent, NOT yet rolled over.
    const start = Math.floor(Date.now() / 1000) - 600;
    fakeChain.policyView.spentInWindow = CAP;
    fakeChain.policyView.windowStart = start;
    let observed: string | null = null;
    nock(UPSTREAM)
      .post('/v1/chat/completions', (body: { messages?: Array<{ role: string; content: string }> }) => {
        observed = body.messages?.find((m) => m.role === 'user')?.content ?? null;
        return true;
      })
      .reply(200, {
        id: 'c',
        choices: [{ message: { role: 'assistant', content: JSON.stringify({ action: 'stand_down', amountWei: '0', reason: 'noop' }) } }],
        x_0g_trace: { provider: 'p', request_id: 'r', billing: {} },
      });
    await manager.start(id);
    startedAgents.push(id);
    await waitFor(() => observed !== null);
    await manager.settle(id);
    const policy = (JSON.parse(String(observed).replace(/^Observation:\n/, '')) as {
      policy: { spentInWindowWei: string; remainingWindowWei: string; windowResetsAtUnix: number };
    }).policy;
    expect(policy.spentInWindowWei).toBe(CAP.toString());
    expect(policy.remainingWindowWei).toBe((2n * CAP).toString());
    expect(policy.windowResetsAtUnix).toBe(start + 3600);
  });

  it('lazy rollover: past the boundary the observation reports a reset window (remaining = full cap)', async () => {
    const id = await seedRuntimeAgent();
    fakeChain.policyView.spentInWindow = 3n * CAP; // storage says exhausted…
    fakeChain.policyView.windowStart = Math.floor(Date.now() / 1000) - 7200; // …but the window passed
    let observed: string | null = null;
    nock(UPSTREAM)
      .post('/v1/chat/completions', (body: { messages?: Array<{ role: string; content: string }> }) => {
        observed = body.messages?.find((m) => m.role === 'user')?.content ?? null;
        return true;
      })
      .reply(200, {
        id: 'c',
        choices: [{ message: { role: 'assistant', content: JSON.stringify({ action: 'stand_down', amountWei: '0', reason: 'noop' }) } }],
        x_0g_trace: { provider: 'p', request_id: 'r', billing: {} },
      });
    await manager.start(id);
    startedAgents.push(id);
    await waitFor(() => observed !== null);
    await manager.settle(id);
    const policy = (JSON.parse(String(observed).replace(/^Observation:\n/, '')) as {
      policy: { spentInWindowWei: string; remainingWindowWei: string };
    }).policy;
    expect(policy.spentInWindowWei).toBe('0'); // logically reset
    expect(policy.remainingWindowWei).toBe((3n * CAP).toString());
  });
});

describe('D8 — boundary damping', () => {
  it('forced OverWindowCap → ONE limit_hit alert + zero further act attempts over 3 cycles → resumes on policy change', async () => {
    const id = await seedRuntimeAgent();
    // Window exhausted per the CONTRACT but not yet per pre-flight (make the
    // pre-flight see remaining > amount so the first attempt reaches the
    // chain and reverts — exercising the DECODE-driven activation).
    fakeChain.policyView.spentInWindow = 0n; // stale getter (rollup lag simulation)
    fakeChain.revertAllExecutes = true;
    mockModelDecision(SEND, 8);

    await manager.start(id);
    startedAgents.push(id);
    await manager.settle(id);
    await waitFor(async () => {
      const traces = await listTraces(db.pool, id);
      return traces.some((r) => r.kind === 'decision' && JSON.stringify(r.detail).includes('OverWindowCap'));
    });

    // The decoded revert is chain-visible with plain copy (D7).
    const traces1 = await listTraces(db.pool, id);
    const failed = traces1.find((r) => r.kind === 'decision' && JSON.stringify(r.detail).includes('OverWindowCap'));
    expect(JSON.stringify(failed?.detail)).toContain('window cap');

    // Exactly ONE limit_hit decision alert.
    const { alerts } = await listAlerts(db.pool, OWNER, { kind: 'limit_hit', agentId: id });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.class).toBe('decision');
    expect(alerts[0]?.refs.errorName).toBe('OverWindowCap');
    const alertId = alerts[0]?.id ?? '';

    // Three more cycles: ZERO act attempts (damped stand-downs, no gas).
    const executeAttemptsBefore = fakeChain.executed.length;
    for (let i = 0; i < 3; i++) await runOneCycle(id);
    expect(fakeChain.executed.length).toBe(executeAttemptsBefore);
    const dampedTraces = await listTraces(db.pool, id);
    expect(
      dampedTraces.filter((r) => r.kind === 'decision' && JSON.stringify(r.detail).includes('boundary active')).length,
    ).toBeGreaterThanOrEqual(3);
    // Still ONE alert (deduped per boundary), count possibly grown? No —
    // damped cycles never re-activate; the row stays as-is.
    const again = await listAlerts(db.pool, OWNER, { kind: 'limit_hit', agentId: id });
    expect(again.alerts).toHaveLength(1);

    // Boundary clears on POLICY CHANGE (owner raises the window cap) —
    // normal flow resumes and the limit_hit alert auto-resolves.
    fakeChain.revertAllExecutes = false;
    fakeChain.policyView = { ...fakeChain.policyView, windowCap: 30n * CAP };
    await runOneCycle(id);
    await waitFor(() => fakeChain.executed.length === 1);
    const resolved = await getAlert(db.pool, alertId);
    expect(resolved?.status).toBe('resolved');
  }, 240_000);

  it('pre-flight: an exhausted window stands down WITHOUT any chain attempt (no gas burned)', async () => {
    const id = await seedRuntimeAgent();
    fakeChain.policyView.spentInWindow = 3n * CAP; // remaining = 0, window current
    fakeChain.policyView.windowStart = Math.floor(Date.now() / 1000) - 60;
    mockModelDecision(SEND, 2);
    await manager.start(id);
    startedAgents.push(id);
    await manager.settle(id);
    // The alert fires in decide (before the record node) — wait for BOTH.
    await waitFor(async () => {
      const { alerts } = await listAlerts(db.pool, OWNER, { kind: 'limit_hit', agentId: id });
      const traces = await listTraces(db.pool, id);
      return alerts.length === 1 && traces.some((r) => JSON.stringify(r.detail ?? {}).includes('window'));
    });
    expect(fakeChain.executed).toHaveLength(0); // never reached the chain
  });
});
