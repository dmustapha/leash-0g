import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { TEST_KEYRING } from '../helpers/app.js';
import { SseHub } from '../../src/sse/hub.js';
import { ApprovalBroker } from '../../src/approvals/broker.js';
import { LeashRuntimeManager } from '../../src/runtime/manager.js';
import { generateGatewayToken, hashTokenSecret } from '../../src/crypto/token.js';
import { encryptSecret } from '../../src/crypto/keycrypt.js';
import type { RuntimeChain } from '../../src/runtime/session-chain.js';
import type { AlertService } from '../../src/alerts/service.js';
import type { PolicyView } from '../../src/types.js';

/**
 * AQ-FND beta slice E1 — the loop-breaker. A cycle that throws counts; N consecutive failures
 * pause the agent (loop stops, DB row stays active) with ONE trace row and ONE owner alert;
 * a cycle that returns resets the count; budget 0 disables; Resume (start) gets a fresh budget.
 * The fake chain throws from getBalance, which the very first graph node reads.
 */
const OWNER = '0x' + '4b'.repeat(20);
const SESSION_PK = '0x' + '6d'.repeat(32);
const CAP = 10n ** 16n;
/** the graph reads balance twice in a failing cycle (one node retry) — asserted in the first test. */
const READS_PER_FAILED_CYCLE = 2;

class FlakyChain implements RuntimeChain {
  failing = true;
  /** when set, throw for exactly this many reads then recover (a failed cycle makes READS_PER_FAILED_CYCLE reads). */
  throwsLeft: number | null = null;
  balanceReads = 0;
  policyView: PolicyView = {
    perTransferCap: CAP, windowCap: 3n * CAP, windowSeconds: 3600,
    expiresAt: Math.floor(Date.now() / 1000) + 86_400, allowlist: [], revoked: false,
    spentInWindow: 0n, windowStart: Math.floor(Date.now() / 1000),
  };
  async getBalance(): Promise<bigint> {
    this.balanceReads += 1;
    if (this.throwsLeft !== null) {
      if (this.throwsLeft > 0) {
        this.throwsLeft -= 1;
        throw new Error('rpc exploded');
      }
    } else if (this.failing) throw new Error('rpc exploded');
    return 10n ** 18n;
  }
  async getPolicyView(): Promise<PolicyView> { return this.policyView; }
  async executeTransfer(): Promise<{ txHash: string }> { return { txHash: '0x' + 'ee'.repeat(32) }; }
  async executeTokenTransfer(): Promise<{ txHash: string }> { return { txHash: '0x' + 'dd'.repeat(32) }; }
  async executeCall(): Promise<{ txHash: string }> { return { txHash: '0x' + 'cc'.repeat(32) }; }
  async getErc20Balance(): Promise<bigint> { return 0n; }
  async getErc20Allowance(): Promise<bigint> { return 0n; }
  async getSwapBandPrice18(): Promise<bigint | null> { return null; }
  async getErc20Meta(): Promise<{ symbol: string; decimals: number }> { return { symbol: '0G', decimals: 18 }; }
  async readCallGrantState(): Promise<never> { throw new Error('unused'); }
  async readOneShotAuth(): Promise<bigint> { return 0n; }
}

/** The model gateway: always decides to stand down, so a cycle whose chain reads succeed RETURNS normally. */
const standDownModel = (async () =>
  new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ action: 'stand_down', amountWei: '0', reason: 'noop' }) } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;

let db: TestDb;
let checkpointer: PostgresSaver;
beforeAll(async () => {
  db = await createTestDb();
  checkpointer = new PostgresSaver(db.pool, undefined, { schema: db.schema });
  await checkpointer.setup();
});
afterAll(async () => { await db.drop(); });

let seq = 0;
async function seed(): Promise<string> {
  seq += 1;
  const account = '0x' + seq.toString(16).padStart(2, '0').repeat(20);
  const gen = generateGatewayToken();
  return seedAgent(db.pool, {
    ownerAddr: OWNER, accountAddr: account, tokenId: gen.tokenId, tokenHash: await hashTokenSecret(gen.secret),
    sessionKeyEnc: encryptSecret(SESSION_PK, TEST_KEYRING), gatewayTokenEnc: encryptSecret(gen.token, TEST_KEYRING),
    goal: { beneficiary: '0x' + '9c'.repeat(20), targetBalanceWei: (50n * CAP).toString(), topUpWei: (CAP / 2n).toString(), model: 'test-model' },
  });
}

function rig(chain: FlakyChain, failureBudget: number) {
  const alerts: Array<{ kind: string; dedupKey?: string; summary: string }> = [];
  const alertStub = { emit: async (_o: string, a: { kind: string; dedupKey?: string; summary: string }) => { alerts.push(a); return null; } } as unknown as AlertService;
  const manager = new LeashRuntimeManager({
    pool: db.pool, hub: new SseHub(), broker: new ApprovalBroker(), chain, alerts: alertStub,
    checkpointer,
    settings: { keyring: TEST_KEYRING, approvalTimeoutMs: 600_000, gatewayUrl: 'http://127.0.0.1:0', intervalMs: 5, maxBackoffMs: 5, defaultModel: 'test-model', jitTtlMs: 600_000, failureBudget, fetchFn: standDownModel },
  });
  return { manager, alerts };
}

async function until(cond: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const pauseTraces = async (id: string): Promise<number> =>
  Number((await db.pool.query(`SELECT count(*) c FROM trace_records WHERE agent_id=$1 AND record->'detail'->>'summary' LIKE 'paused after%'`, [id])).rows[0].c);

describe('E1 loop-breaker', () => {
  it('pauses after N consecutive failures: loop stops, DB row stays active, one trace, one alert, no more cycles', async () => {
    const chain = new FlakyChain();
    const { manager, alerts } = rig(chain, 3);
    const id = await seed();
    await manager.start(id);
    await until(() => !manager.isRunning(id));
    const reads = chain.balanceReads;
    expect(reads).toBe(3 * READS_PER_FAILED_CYCLE);
    await new Promise((r) => setTimeout(r, 80)); // no further cycles after the pause
    expect(chain.balanceReads).toBe(reads);
    expect((await db.pool.query('SELECT status FROM agents WHERE id=$1', [id])).rows[0].status).toBe('active');
    expect(await pauseTraces(id)).toBe(1);
    expect(alerts.filter((a) => a.dedupKey === `breaker:${id}`)).toHaveLength(1);
    expect(alerts.find((a) => a.dedupKey === `breaker:${id}`)?.summary).toMatch(/paused itself.*rpc exploded.*Resume/);
  });

  it('a successful cycle resets the count, so intermittent failures never trip', async () => {
    const chain = new FlakyChain();
    const { manager } = rig(chain, 3);
    const id = await seed();
    for (let round = 0; round < 2; round += 1) {
      chain.throwsLeft = 2 * READS_PER_FAILED_CYCLE; // two failed cycles (under the budget of 3) ...
      if (round === 0) await manager.start(id);
      await until(() => chain.throwsLeft === 0);
      const ok = chain.balanceReads + 4; // ... then healthy cycles reset the count
      await until(() => chain.balanceReads >= ok);
    }
    expect(manager.isRunning(id)).toBe(true);
    expect(await pauseTraces(id)).toBe(0);
    await manager.stop(id);
  });

  it('budget 0 disables the breaker (old behaviour: retries forever)', async () => {
    const chain = new FlakyChain();
    const { manager } = rig(chain, 0);
    const id = await seed();
    await manager.start(id);
    await until(() => chain.balanceReads >= 12);
    expect(manager.isRunning(id)).toBe(true);
    await manager.stop(id);
  });

  it('Resume (start) after a trip runs again with a fresh budget', async () => {
    const chain = new FlakyChain();
    const { manager } = rig(chain, 2);
    const id = await seed();
    await manager.start(id);
    await until(() => !manager.isRunning(id));
    chain.failing = false;
    await manager.start(id);
    const reads = chain.balanceReads;
    await until(() => chain.balanceReads >= reads + 3);
    expect(manager.isRunning(id)).toBe(true);
    await manager.stop(id);
  });
});
