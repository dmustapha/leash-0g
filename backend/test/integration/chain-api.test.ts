import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { buildTestApp, ownerAuth, type TestApp } from '../helpers/app.js';
import { getAgentById } from '../../src/store/agents.js';
import { createLink, listDelegations } from '../../src/coordination/store.js';
import { insertDirectionDraft } from '../../src/store/directions.js';
import type { AgentRow } from '../../src/types.js';
import type { DirectionDraft } from '../../src/direction/direction.js';

/**
 * Phase 5.6 chain routes (D-1/D-6/D-8): confirm carries an owner-authored
 * chainPlan (arms NO delegation), invalid plans are visible 400s, and the
 * chain read-model is owner-scoped + read-only + cross-owner-isolated.
 */

let db: TestDb;
let t: TestApp;
const OWNER = '0x' + 'a2'.repeat(20);
const OTHER = '0x' + 'b3'.repeat(20);

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});
beforeEach(() => {
  t = buildTestApp(db.pool);
});

let seq = 0;
async function seed(owner: string, goal: Record<string, unknown> = {}): Promise<AgentRow> {
  seq += 1;
  const suffix = seq.toString(16).padStart(4, '0');
  const id = await seedAgent(db.pool, {
    ownerAddr: owner,
    name: `api-${seq}`,
    accountAddr: `0x${'ac'.repeat(18)}${suffix}`,
    sessionKeyAddr: `0x${'5e'.repeat(18)}${suffix}`,
    goal,
  });
  const a = await getAgentById(db.pool, id);
  if (!a) throw new Error('seed failed');
  return a;
}
const SENTINEL = { type: 'sentinel', beneficiary: '0x' + '11'.repeat(20), targetBalanceWei: '1' };

async function draft(agent: AgentRow, owner: string): Promise<string> {
  const d: DirectionDraft = {
    agentId: agent.id,
    currentRole: 'treasury',
    understanding: 'x',
    goalPatch: {},
    moneyPower: 'can-move-money',
    unsureFields: [],
    confidence: 'high',
  };
  const row = await insertDirectionDraft(db.pool, { agentId: agent.id, ownerAddr: owner, intent: 'x', draft: d });
  return row.id;
}

describe('POST confirm with chainPlan (D-1/D-2)', () => {
  it('records a planned chain, arms NO delegation', async () => {
    const origin = await seed(OWNER);
    const target = await seed(OWNER, SENTINEL);
    await createLink(db.pool, { ownerAddr: OWNER, fromAgentId: origin.id, toAgentId: target.id, mode: 'auto' });
    const directionId = await draft(origin, OWNER);
    const res = await request(t.ownerApp)
      .post(`/api/agents/${origin.id}/direct/${directionId}/confirm`)
      .set('authorization', ownerAuth(OWNER))
      .send({ edited: { goalPatch: {} }, chainPlan: [{ eligibleTargetIds: [target.id], directedIntent: 'go' }] });
    expect(res.status).toBe(200);
    // quarantine: zero delegations exist post-confirm
    const { delegations } = await listDelegations(db.pool, {});
    expect(delegations).toHaveLength(0);
    // the planned chain is queryable
    const list = await request(t.ownerApp).get('/api/chains').set('authorization', ownerAuth(OWNER));
    expect(list.status).toBe(200);
    expect(list.body.chains).toHaveLength(1);
    expect(list.body.chains[0].status).toBe('planned');
  });

  it('rejects a cross-owner chain target → 400 invalid_chain (no confirm side-effect leak)', async () => {
    const origin = await seed(OWNER);
    const foreign = await seed(OTHER, SENTINEL);
    const directionId = await draft(origin, OWNER);
    const res = await request(t.ownerApp)
      .post(`/api/agents/${origin.id}/direct/${directionId}/confirm`)
      .set('authorization', ownerAuth(OWNER))
      .send({ edited: { goalPatch: {} }, chainPlan: [{ eligibleTargetIds: [foreign.id], directedIntent: 'go' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_chain');
  });

  it('a directive with no chainPlan still confirms (no chain created)', async () => {
    const solo = '0x' + 'c4'.repeat(20); // isolated owner (chains persist across tests in one schema)
    const origin = await seed(solo);
    const directionId = await draft(origin, solo);
    const res = await request(t.ownerApp)
      .post(`/api/agents/${origin.id}/direct/${directionId}/confirm`)
      .set('authorization', ownerAuth(solo))
      .send({ edited: { goalPatch: {} } });
    expect(res.status).toBe(200);
    const list = await request(t.ownerApp).get('/api/chains').set('authorization', ownerAuth(solo));
    expect(list.body.chains).toHaveLength(0);
  });
});

describe('GET /api/chains* (D-6/D-8)', () => {
  it('cross-owner GET /api/chains/:id → 404', async () => {
    const origin = await seed(OWNER);
    const target = await seed(OWNER, SENTINEL);
    await createLink(db.pool, { ownerAddr: OWNER, fromAgentId: origin.id, toAgentId: target.id, mode: 'auto' });
    const directionId = await draft(origin, OWNER);
    await request(t.ownerApp)
      .post(`/api/agents/${origin.id}/direct/${directionId}/confirm`)
      .set('authorization', ownerAuth(OWNER))
      .send({ edited: { goalPatch: {} }, chainPlan: [{ eligibleTargetIds: [target.id], directedIntent: 'go' }] });
    const list = await request(t.ownerApp).get('/api/chains').set('authorization', ownerAuth(OWNER));
    const chainId = list.body.chains[0].id;
    // other owner cannot read it
    const foreign = await request(t.ownerApp).get(`/api/chains/${chainId}`).set('authorization', ownerAuth(OTHER));
    expect(foreign.status).toBe(404);
    // owner can, with ordered hops
    const mine = await request(t.ownerApp).get(`/api/chains/${chainId}`).set('authorization', ownerAuth(OWNER));
    expect(mine.status).toBe(200);
    expect(mine.body.chain.id).toBe(chainId);
    expect(Array.isArray(mine.body.hops)).toBe(true);
  });
});
