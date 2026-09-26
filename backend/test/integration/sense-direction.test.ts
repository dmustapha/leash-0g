import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { SseHub } from '../../src/sse/hub.js';
import { makeSenseDirection } from '../../src/runtime/sense-direction.js';
import { insertDirectionDraft, confirmDirection, getDirection } from '../../src/store/directions.js';
import { getAgentById } from '../../src/store/agents.js';
import type { AgentGoal } from '../../src/types.js';
import type { DirectionDraft } from '../../src/direction/direction.js';

let db: TestDb;
const OWNER = '0x' + '7a'.repeat(20);
const BENE = '0x' + '11'.repeat(20);
const base: AgentGoal = { type: 'treasury', beneficiary: BENE, targetBalanceWei: '1000', topUpWei: '500' };

function draft(agentId: string): DirectionDraft {
  return { agentId, currentRole: 'treasury', understanding: 'raise target', goalPatch: { targetBalanceWei: '2000' }, moneyPower: 'can-move-money', unsureFields: [], confidence: 'high' };
}

async function confirmedDirection(agentId: string, effective: AgentGoal): Promise<string> {
  const row = await insertDirectionDraft(db.pool, { agentId, ownerAddr: OWNER, intent: 'i', draft: draft(agentId) });
  await confirmDirection(db.pool, row.id, effective);
  return row.id;
}

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

describe('sense_direction — cycle-boundary apply (D-4)', () => {
  it('applies a confirmed directive: reroutes ctx.goal in-memory AND persists, marks applied, traces it', async () => {
    const agentId = await seedAgent(db.pool, { ownerAddr: OWNER, goal: base as unknown as Record<string, unknown> });
    const effective: AgentGoal = { ...base, targetBalanceWei: '2000' };
    const dirId = await confirmedDirection(agentId, effective);

    const ctx = { agentId, goal: { ...base } as AgentGoal };
    const node = makeSenseDirection({ pool: db.pool, hub: new SseHub() }, ctx);
    await node();

    expect((ctx.goal as { targetBalanceWei: string }).targetBalanceWei).toBe('2000'); // running loop rerouted
    const persisted = await getAgentById(db.pool, agentId);
    expect((persisted?.goal as { targetBalanceWei: string }).targetBalanceWei).toBe('2000'); // persisted
    expect((await getDirection(db.pool, dirId))?.status).toBe('applied');
    const tr = await db.pool.query(`SELECT record FROM trace_records WHERE agent_id=$1 AND kind='direction'`, [agentId]);
    expect(tr.rowCount).toBe(1);
    expect(tr.rows[0].record.detail.applied).toBe(true);
  });

  it('idempotent: a second run with nothing confirmed-unapplied is a no-op', async () => {
    const agentId = await seedAgent(db.pool, { ownerAddr: OWNER, goal: base as unknown as Record<string, unknown> });
    await confirmedDirection(agentId, { ...base, targetBalanceWei: '3000' });
    const ctx = { agentId, goal: { ...base } as AgentGoal };
    const node = makeSenseDirection({ pool: db.pool }, ctx);
    await node();
    await node(); // no confirmed-unapplied remains
    const traces = await db.pool.query(`SELECT count(*)::text AS n FROM trace_records WHERE agent_id=$1 AND kind='direction'`, [agentId]);
    expect(Number(traces.rows[0].n)).toBe(1);
  });

  it('superseded-skip: only the latest confirmed directive applies', async () => {
    const agentId = await seedAgent(db.pool, { ownerAddr: OWNER, goal: base as unknown as Record<string, unknown> });
    await confirmedDirection(agentId, { ...base, targetBalanceWei: '10' });
    await confirmedDirection(agentId, { ...base, targetBalanceWei: '20' }); // supersedes the first
    const ctx = { agentId, goal: { ...base } as AgentGoal };
    await makeSenseDirection({ pool: db.pool }, ctx)();
    expect((ctx.goal as { targetBalanceWei: string }).targetBalanceWei).toBe('20');
  });

  it('R-1 at apply: an out-of-union / role-changed effective goal is REJECTED — goal untouched, consumed', async () => {
    const agentId = await seedAgent(db.pool, { ownerAddr: OWNER, goal: base as unknown as Record<string, unknown> });
    // A tampered effective goal that changes the role (provider) — must not merge.
    const tampered = { type: 'provider', serviceSpec: 'x' } as unknown as AgentGoal;
    const dirId = await confirmedDirection(agentId, tampered);
    const ctx = { agentId, goal: { ...base } as AgentGoal };
    await makeSenseDirection({ pool: db.pool }, ctx)();
    expect((ctx.goal as { type?: string }).type).toBe('treasury'); // unchanged
    expect((ctx.goal as { targetBalanceWei: string }).targetBalanceWei).toBe('1000');
    const persisted = await getAgentById(db.pool, agentId);
    expect((persisted?.goal as { type?: string }).type ?? 'treasury').toBe('treasury');
    expect((await getDirection(db.pool, dirId))?.status).toBe('applied'); // consumed (won't loop)
    const tr = await db.pool.query(`SELECT record FROM trace_records WHERE agent_id=$1 AND kind='direction'`, [agentId]);
    expect(tr.rows[0].record.detail.applied).toBe(false);
  });
});
