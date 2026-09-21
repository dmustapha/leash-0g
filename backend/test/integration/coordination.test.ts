import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { buildTestApp, testSettings, ownerAuth, type TestApp } from '../helpers/app.js';
import { getAgentById } from '../../src/store/agents.js';
import { listTraces } from '../../src/trace/trace-store.js';
import { applyRevokeFanout } from '../../src/agents/revoke-fanout.js';
import { runBootSweep } from '../../src/coordination/coordinator.js';
import {
  createLink,
  createDelegation,
  getDelegation,
  listActivatablePendingFor,
  listDelegations,
  sweepExpiredDelegations,
  transitionDelegation,
} from '../../src/coordination/store.js';
import { CoordinationError, DelegationCoordinator } from '../../src/coordination/coordinator.js';
import type { AgentRow, Delegation, DelegationStatus, TraceRecord } from '../../src/types.js';

/**
 * Coordination backend (PHASE-2 spec §3b/§4/§5, test plan §8 "Coordination
 * (backend)"): link CRUD+authz, the delegation state machine through the
 * single transition writer, supervised consent-before-delivery, three-point
 * expiry, forged-envelope rejection, channel throttles, revoke fan-out, and
 * the new owner routes (fleet list, rules PATCH, revoke-batch).
 *
 * 'transfer.request' appears ONLY as an example kind — the platform never
 * interprets it (generality guard).
 */

let db: TestDb;
let t: TestApp;

const OWNER = '0x' + '5a'.repeat(20);
const OTHER_OWNER = '0x' + '6b'.repeat(20);

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

beforeEach(() => {
  t = buildTestApp(db.pool);
});

let seedSeq = 0;

/** Seed an agent with a unique account address and return the full row. */
async function seedFullAgent(owner = OWNER, name = 'coord-agent'): Promise<AgentRow> {
  seedSeq += 1;
  const suffix = seedSeq.toString(16).padStart(4, '0');
  const id = await seedAgent(db.pool, {
    ownerAddr: owner,
    name: `${name}-${seedSeq}`,
    accountAddr: `0x${'ac'.repeat(18)}${suffix}`,
    sessionKeyAddr: `0x${'5e'.repeat(18)}${suffix}`,
  });
  const agent = await getAgentById(db.pool, id);
  if (!agent) throw new Error('seed failed');
  return agent;
}

async function seedPair(mode: 'auto' | 'supervised' = 'auto'): Promise<{ a: AgentRow; b: AgentRow; linkId: string }> {
  const a = await seedFullAgent(OWNER, 'sentinel');
  const b = await seedFullAgent(OWNER, 'executor');
  const link = await createLink(db.pool, { ownerAddr: OWNER, fromAgentId: a.id, toAgentId: b.id, mode });
  return { a, b, linkId: link.id };
}

function tracesOfKind(records: TraceRecord[], kind: string): TraceRecord[] {
  return records.filter((r) => r.kind === kind);
}

function detailOf(rec: TraceRecord | undefined): Record<string, unknown> {
  return (rec?.detail ?? {}) as Record<string, unknown>;
}

/** Collect every hub emission (agentId, event, data) without needing SSE sockets. */
function spyHub(app: TestApp): Array<{ agentId: string; event: string; data: Record<string, unknown> }> {
  const events: Array<{ agentId: string; event: string; data: Record<string, unknown> }> = [];
  const original = app.hub.emit.bind(app.hub);
  vi.spyOn(app.hub, 'emit').mockImplementation((agentId: string, event: string, data: unknown) => {
    events.push({ agentId, event, data: data as Record<string, unknown> });
    original(agentId, event, data);
  });
  return events;
}

// ---------------------------------------------------------------------------
// Link CRUD + authz
// ---------------------------------------------------------------------------

describe('links: CRUD + authz', () => {
  it('creates a link 201 and traces config on BOTH agents', async () => {
    const a = await seedFullAgent();
    const b = await seedFullAgent();
    const res = await request(t.app)
      .post('/api/links')
      .set('authorization', ownerAuth(OWNER))
      .send({ fromAgentId: a.id, toAgentId: b.id });
    expect(res.status).toBe(201);
    expect(res.body.link.fromAgentId).toBe(a.id);
    expect(res.body.link.toAgentId).toBe(b.id);
    expect(res.body.link.mode).toBe('auto'); // default (autonomy-by-default, 00 §1a)
    expect(res.body.link.status).toBe('active');
    expect(res.body.link.ownerAddr).toBe(OWNER.toLowerCase());
    for (const agentId of [a.id, b.id]) {
      const cfg = tracesOfKind(await listTraces(db.pool, agentId), 'config');
      expect(cfg).toHaveLength(1);
      expect(detailOf(cfg[0])['linkId']).toBe(res.body.link.id);
    }
  });

  it('rejects a cross-owner link with 403 (either side foreign)', async () => {
    const mine = await seedFullAgent(OWNER);
    const theirs = await seedFullAgent(OTHER_OWNER);
    for (const body of [
      { fromAgentId: mine.id, toAgentId: theirs.id },
      { fromAgentId: theirs.id, toAgentId: mine.id },
    ]) {
      const res = await request(t.app).post('/api/links').set('authorization', ownerAuth(OWNER)).send(body);
      expect(res.status).toBe(403);
    }
  });

  it('rejects a self-link with 403 and an unknown agent with 404', async () => {
    const a = await seedFullAgent();
    const self = await request(t.app)
      .post('/api/links')
      .set('authorization', ownerAuth(OWNER))
      .send({ fromAgentId: a.id, toAgentId: a.id });
    expect(self.status).toBe(403);
    const missing = await request(t.app)
      .post('/api/links')
      .set('authorization', ownerAuth(OWNER))
      .send({ fromAgentId: a.id, toAgentId: '00000000-0000-4000-8000-000000000000' });
    expect(missing.status).toBe(404);
  });

  it('rejects a duplicate (from,to) with 409', async () => {
    const { a, b } = await seedPair();
    const res = await request(t.app)
      .post('/api/links')
      .set('authorization', ownerAuth(OWNER))
      .send({ fromAgentId: a.id, toAgentId: b.id });
    expect(res.status).toBe(409);
  });

  it('pause → resume → remove; removed links cannot be resumed or re-moded', async () => {
    const { linkId } = await seedPair();
    const act = (body: Record<string, string>) =>
      request(t.app).post(`/api/links/${linkId}`).set('authorization', ownerAuth(OWNER)).send(body);

    const paused = await act({ action: 'pause' });
    expect(paused.status).toBe(200);
    expect(paused.body.link.status).toBe('paused');

    const resumed = await act({ action: 'resume' });
    expect(resumed.body.link.status).toBe('active');

    const removed = await act({ action: 'remove' });
    expect(removed.body.link.status).toBe('removed');

    expect((await act({ action: 'resume' })).status).toBe(409);
    expect((await act({ mode: 'supervised' })).status).toBe(409);
  });

  it('rejects action+mode together and an empty body (XOR)', async () => {
    const { linkId } = await seedPair();
    const both = await request(t.app)
      .post(`/api/links/${linkId}`)
      .set('authorization', ownerAuth(OWNER))
      .send({ action: 'pause', mode: 'auto' });
    expect(both.status).toBe(400);
    const neither = await request(t.app)
      .post(`/api/links/${linkId}`)
      .set('authorization', ownerAuth(OWNER))
      .send({});
    expect(neither.status).toBe(400);
  });

  it('mode change is traced config on both agents; foreign owner gets 403', async () => {
    const { a, b, linkId } = await seedPair();
    const res = await request(t.app)
      .post(`/api/links/${linkId}`)
      .set('authorization', ownerAuth(OWNER))
      .send({ mode: 'supervised' });
    expect(res.status).toBe(200);
    expect(res.body.link.mode).toBe('supervised');
    for (const agentId of [a.id, b.id]) {
      const cfg = tracesOfKind(await listTraces(db.pool, agentId), 'config');
      // seedPair creates the link via the store (untraced) — the mode change
      // is the ONE config record here; API-created links are covered above.
      expect(cfg).toHaveLength(1);
      expect(detailOf(cfg[0])['mode']).toBe('supervised');
    }
    const foreign = await request(t.app)
      .post(`/api/links/${linkId}`)
      .set('authorization', ownerAuth(OTHER_OWNER))
      .send({ action: 'pause' });
    expect(foreign.status).toBe(403);
  });

  it('GET /api/links lists only the owner links with per-link delegation counts', async () => {
    const { a, linkId } = await seedPair();
    const foreignA = await seedFullAgent(OTHER_OWNER);
    const foreignB = await seedFullAgent(OTHER_OWNER);
    await createLink(db.pool, { ownerAddr: OTHER_OWNER, fromAgentId: foreignA.id, toAgentId: foreignB.id, mode: 'auto' });
    await t.coordinator.issueDelegation({ fromAgent: a, kind: 'transfer.request', payload: { n: 1 } });
    await t.coordinator.issueDelegation({ fromAgent: a, kind: 'transfer.request', payload: { n: 2 } });

    const res = await request(t.app).get('/api/links').set('authorization', ownerAuth(OWNER));
    expect(res.status).toBe(200);
    const links = res.body.links as Array<{ id: string; ownerAddr: string; delegationCount: number }>;
    const mine = links.filter((l) => l.id === linkId);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.delegationCount).toBe(2);
    for (const l of links) expect(l.ownerAddr).toBe(OWNER.toLowerCase());
  });
});

// ---------------------------------------------------------------------------
// Delegation lifecycle — happy path on an auto link
// ---------------------------------------------------------------------------

describe('delegation lifecycle (auto link)', () => {
  it('issue → pending: nudges the receiver, traces delegate on the issuer WITH payload, SSE both sides', async () => {
    const events = spyHub(t);
    const { a, b, linkId } = await seedPair('auto');
    const payload = { beneficiary: '0x' + '9c'.repeat(20), amountWei: '1000', rationale: 'top-up warranted' };
    const d = await t.coordinator.issueDelegation({ fromAgent: a, kind: 'transfer.request', payload });

    expect(d.status).toBe('pending');
    expect(d.linkId).toBe(linkId);
    expect(d.fromAgentId).toBe(a.id);
    expect(d.toAgentId).toBe(b.id);
    expect(Date.parse(d.expiresAt)).toBeGreaterThan(Date.now() + 500_000); // ~10 min TTL

    // delivery nudge fired at the receiver
    expect(t.runtime.nudges).toEqual([b.id]);

    // issuer chain: 'delegate' with the full payload (rides the encrypted record)
    const del = tracesOfKind(await listTraces(db.pool, a.id), 'delegate');
    expect(del).toHaveLength(1);
    const detail = detailOf(del[0]);
    expect(detail['delegationId']).toBe(d.id);
    expect(detail['counterpartyAgentId']).toBe(b.id);
    expect(detail['kind']).toBe('transfer.request');
    expect(detail['payload']).toEqual(payload);

    // DelegationEvent SSE on BOTH agents' streams, direction flipped per side
    const frames = events.filter((e) => e.event === 'delegation');
    const outbound = frames.find((e) => e.agentId === a.id);
    const inbound = frames.find((e) => e.agentId === b.id);
    expect(outbound?.data).toMatchObject({
      type: 'delegation',
      delegationId: d.id,
      linkId,
      status: 'pending',
      kind: 'transfer.request',
      counterpartyAgentId: b.id,
      direction: 'outbound',
    });
    expect(inbound?.data).toMatchObject({ direction: 'inbound', counterpartyAgentId: a.id });
    // the SSE frame must NOT leak the payload (owner-only decrypt discipline)
    expect(outbound?.data['payload']).toBeUndefined();
  });

  it('pending → accepted → completed({txHash}): receiver-chain traces + result stored', async () => {
    const events = spyHub(t);
    const { a, b } = await seedPair('auto');
    const d = await t.coordinator.issueDelegation({ fromAgent: a, kind: 'transfer.request', payload: { x: 1 } });

    // receiver pickup sees it
    const activatable = await listActivatablePendingFor(db.pool, b.id);
    expect(activatable.map((r) => r.id)).toContain(d.id);

    const accepted = await t.coordinator.markAccepted(d.id);
    expect(accepted?.status).toBe('accepted');

    const txHash = '0x' + 'fe'.repeat(32);
    const completed = await t.coordinator.markCompleted(d.id, { txHash });
    expect(completed?.status).toBe('completed');
    expect(completed?.result).toEqual({ txHash });
    expect(completed?.decidedAt).toBeDefined();

    const row = await getDelegation(db.pool, d.id);
    expect(row?.status).toBe('completed');
    expect(row?.result).toEqual({ txHash });

    // receiver chain carries accepted + completed updates with the SAME delegationId (D3 correlation)
    const updates = tracesOfKind(await listTraces(db.pool, b.id), 'delegation_update');
    expect(updates.map((r) => detailOf(r)['status'])).toEqual(['accepted', 'completed']);
    for (const rec of updates) expect(detailOf(rec)['delegationId']).toBe(d.id);
    // issuer chain has the delegate record but NO receiver-side updates
    expect(tracesOfKind(await listTraces(db.pool, a.id), 'delegation_update')).toHaveLength(0);

    // both sides saw every transition over SSE
    const statuses = (agentId: string) =>
      events.filter((e) => e.event === 'delegation' && e.agentId === agentId).map((e) => e.data['status']);
    expect(statuses(a.id)).toEqual(['pending', 'accepted', 'completed']);
    expect(statuses(b.id)).toEqual(['pending', 'accepted', 'completed']);
  });

  it('markFailed stores {error} and traces on the receiver chain', async () => {
    const { a, b } = await seedPair('auto');
    const d = await t.coordinator.issueDelegation({ fromAgent: a, kind: 'job.run', payload: {} });
    await t.coordinator.markAccepted(d.id);
    const failed = await t.coordinator.markFailed(d.id, 'policy revert: over cap');
    expect(failed?.status).toBe('failed');
    expect(failed?.result).toEqual({ error: 'policy revert: over cap' });
    const updates = tracesOfKind(await listTraces(db.pool, b.id), 'delegation_update');
    expect(detailOf(updates[updates.length - 1])['status']).toBe('failed');
  });

  it('markDeclinedByReceiver declines an undelivered pending envelope', async () => {
    const { a, b } = await seedPair('auto');
    const d = await t.coordinator.issueDelegation({ fromAgent: a, kind: 'job.run', payload: {} });
    const declined = await t.coordinator.markDeclinedByReceiver(d.id, 'not my job');
    expect(declined?.status).toBe('declined');
    const updates = tracesOfKind(await listTraces(db.pool, b.id), 'delegation_update');
    expect(detailOf(updates[0])['status']).toBe('declined');
  });
});

// ---------------------------------------------------------------------------
// Supervised links — consent gates delivery
// ---------------------------------------------------------------------------

describe('supervised link', () => {
  it('issue → pending_approval: approval created + SSE, NOT delivered, no nudge', async () => {
    const events = spyHub(t);
    const { a, b } = await seedPair('supervised');
    const d = await t.coordinator.issueDelegation({ fromAgent: a, kind: 'transfer.request', payload: { q: 1 } });
    expect(d.status).toBe('pending_approval');
    expect(t.runtime.nudges).toEqual([]); // delivery is gated on consent

    // approval row exists on the ISSUER, requestRef carries the delegation ref
    const approvals = await db.pool.query<{ id: string; agent_id: string; request_ref: Record<string, unknown> }>(
      `SELECT id, agent_id, request_ref FROM approvals WHERE agent_id = $1`,
      [a.id],
    );
    expect(approvals.rows).toHaveLength(1);
    expect(approvals.rows[0]?.request_ref).toMatchObject({ type: 'delegation', delegationId: d.id, toAgentId: b.id });

    // approval card SSE fired on the issuer stream (existing approvalEvent shape)
    const card = events.find((e) => e.event === 'approval' && e.agentId === a.id);
    expect(card?.data['approvalId']).toBe(approvals.rows[0]?.id);
    expect(String(card?.data['summary'])).toContain('handoff');

    // NOT activatable for the receiver until approved
    expect(await listActivatablePendingFor(db.pool, b.id)).toEqual([]);
  });

  it('owner approve → pending + nudge, with consent durable STRICTLY BEFORE delivery', async () => {
    const { a, b } = await seedPair('supervised');
    const d = await t.coordinator.issueDelegation({ fromAgent: a, kind: 'transfer.request', payload: {} });
    const approvalId = (
      await db.pool.query<{ id: string }>(`SELECT id FROM approvals WHERE agent_id = $1`, [a.id])
    ).rows[0]?.id;

    const res = await request(t.app)
      .post(`/api/approvals/${approvalId}`)
      .set('authorization', ownerAuth(OWNER))
      .send({ decision: 'approve' });
    expect(res.status).toBe(200);

    const row = await getDelegation(db.pool, d.id);
    expect(row?.status).toBe('pending');
    expect(t.runtime.nudges).toEqual([b.id]);
    expect(await listActivatablePendingFor(db.pool, b.id)).toHaveLength(1);

    // consent-seq < delivery-seq on the issuer chain (spec §3b ordering)
    const traces = await listTraces(db.pool, a.id);
    const consent = traces.find((r) => r.kind === 'consent');
    const update = traces.find((r) => r.kind === 'delegation_update' && detailOf(r)['status'] === 'pending');
    if (!consent || !update) throw new Error('consent or delivery trace missing');
    expect(consent.seq).toBeLessThan(update.seq);
    expect(consent.decision).toBe('approve');
  });

  it('owner deny → declined, never delivered', async () => {
    const { a, b } = await seedPair('supervised');
    const d = await t.coordinator.issueDelegation({ fromAgent: a, kind: 'transfer.request', payload: {} });
    const approvalId = (
      await db.pool.query<{ id: string }>(`SELECT id FROM approvals WHERE agent_id = $1`, [a.id])
    ).rows[0]?.id;
    const res = await request(t.app)
      .post(`/api/approvals/${approvalId}`)
      .set('authorization', ownerAuth(OWNER))
      .send({ decision: 'deny', reason: 'not now' });
    expect(res.status).toBe(200);
    const row = await getDelegation(db.pool, d.id);
    expect(row?.status).toBe('declined');
    expect(row?.decidedAt).toBeDefined();
    expect(t.runtime.nudges).toEqual([]);
    expect(await listActivatablePendingFor(db.pool, b.id)).toEqual([]);
  });

  it('unapproved supervised delegation expires via the sweeper (pending_approval → expired)', async () => {
    t = buildTestApp(db.pool, { settings: testSettings({ delegationTtlMs: 1 }) });
    const { a } = await seedPair('supervised');
    const d = await t.coordinator.issueDelegation({ fromAgent: a, kind: 'transfer.request', payload: {} });
    await new Promise((r) => setTimeout(r, 10));
    const swept = await t.coordinator.sweepOnce();
    expect(swept.map((s) => s.id)).toContain(d.id);
    expect((await getDelegation(db.pool, d.id))?.status).toBe('expired');
  });
});

// ---------------------------------------------------------------------------
// Three-point expiry (spec §3b: pickup refusal, sweeper, boot sweep)
// ---------------------------------------------------------------------------

describe('three-point expiry', () => {
  it('(a) pickup refusal: an expired pending row is NOT activatable but IS sweepable', async () => {
    t = buildTestApp(db.pool, { settings: testSettings({ delegationTtlMs: 1 }) });
    const { a, b } = await seedPair('auto');
    const d = await t.coordinator.issueDelegation({ fromAgent: a, kind: 'transfer.request', payload: {} });
    await new Promise((r) => setTimeout(r, 10));
    // still 'pending' in the DB, but the pickup query refuses it
    expect((await getDelegation(db.pool, d.id))?.status).toBe('pending');
    expect(await listActivatablePendingFor(db.pool, b.id)).toEqual([]);
    const swept = await sweepExpiredDelegations(db.pool);
    expect(swept.map((s) => s.id)).toContain(d.id);
  });

  it('(b) sweeper: stale rows → expired, traced on the issuer chain, SSE both sides', async () => {
    t = buildTestApp(db.pool, { settings: testSettings({ delegationTtlMs: 1 }) });
    const events = spyHub(t);
    const { a, b } = await seedPair('auto');
    const d = await t.coordinator.issueDelegation({ fromAgent: a, kind: 'transfer.request', payload: {} });
    await new Promise((r) => setTimeout(r, 10));
    const swept = await t.coordinator.sweepOnce();
    expect(swept.map((s) => s.id)).toContain(d.id);
    expect((await getDelegation(db.pool, d.id))?.status).toBe('expired');
    const updates = tracesOfKind(await listTraces(db.pool, a.id), 'delegation_update');
    expect(detailOf(updates[0])['status']).toBe('expired');
    const frames = events.filter((e) => e.event === 'delegation' && e.data['status'] === 'expired');
    expect(frames.map((e) => e.agentId).sort()).toEqual([a.id, b.id].sort());
  });

  it('(b2) the interval-driven sweeper fires on its own', async () => {
    t = buildTestApp(db.pool, { settings: testSettings({ delegationTtlMs: 1 }) });
    const { a } = await seedPair('auto');
    const d = await t.coordinator.issueDelegation({ fromAgent: a, kind: 'transfer.request', payload: {} });
    t.coordinator.startSweeper(25);
    try {
      await vi.waitFor(
        async () => {
          expect((await getDelegation(db.pool, d.id))?.status).toBe('expired');
        },
        { timeout: 5_000, interval: 50 },
      );
    } finally {
      t.coordinator.stopSweeper();
    }
  });

  it('(c) boot sweep expires orphans after a crash/restart (runBootSweep)', async () => {
    t = buildTestApp(db.pool, { settings: testSettings({ delegationTtlMs: 1 }) });
    const { a } = await seedPair('supervised');
    const d = await t.coordinator.issueDelegation({ fromAgent: a, kind: 'transfer.request', payload: {} });
    await new Promise((r) => setTimeout(r, 10));
    // fresh hub = post-restart process
    const rebooted = buildTestApp(db.pool);
    const swept = await runBootSweep(db.pool, rebooted.hub);
    expect(swept.map((s) => s.id)).toContain(d.id);
    expect((await getDelegation(db.pool, d.id))?.status).toBe('expired');
  });
});

// ---------------------------------------------------------------------------
// Forged envelopes — every unauthorized issuance path rejected + traced
// ---------------------------------------------------------------------------

describe('forged envelopes', () => {
  async function expectRejected(fromAgent: AgentRow, toAgentId: string | undefined, reason: string): Promise<void> {
    await expect(
      t.coordinator.issueDelegation({
        fromAgent,
        kind: 'transfer.request',
        payload: {},
        ...(toAgentId !== undefined ? { toAgentId } : {}),
      }),
    ).rejects.toMatchObject({ reason });
    const errs = tracesOfKind(await listTraces(db.pool, fromAgent.id), 'error');
    expect(errs.length).toBeGreaterThan(0);
    expect(detailOf(errs[errs.length - 1])['reason']).toBe(reason);
  }

  it('no link at all → rejected + traced', async () => {
    const lone = await seedFullAgent();
    await expectRejected(lone, undefined, 'delegation_no_active_link');
  });

  it('paused and removed links block issuance', async () => {
    const { a, linkId } = await seedPair('auto');
    await request(t.app).post(`/api/links/${linkId}`).set('authorization', ownerAuth(OWNER)).send({ action: 'pause' });
    await expectRejected(a, undefined, 'delegation_no_active_link');
    await request(t.app).post(`/api/links/${linkId}`).set('authorization', ownerAuth(OWNER)).send({ action: 'resume' });
    await request(t.app).post(`/api/links/${linkId}`).set('authorization', ownerAuth(OWNER)).send({ action: 'remove' });
    await expectRejected(a, undefined, 'delegation_no_active_link');
  });

  it('wrong direction: a link A→B authorizes nothing from B', async () => {
    const { b } = await seedPair('auto');
    await expectRejected(b, undefined, 'delegation_no_active_link');
  });

  it('cross-owner target: no link can exist, issuance rejected', async () => {
    const { a } = await seedPair('auto');
    const foreign = await seedFullAgent(OTHER_OWNER);
    await expectRejected(a, foreign.id, 'delegation_no_active_link');
  });

  it('replayed/terminal ids are sticky: no transition resurrects a terminal status', async () => {
    const { a } = await seedPair('auto');
    const d = await t.coordinator.issueDelegation({ fromAgent: a, kind: 'transfer.request', payload: {} });
    await t.coordinator.markAccepted(d.id);
    await t.coordinator.markCompleted(d.id, { txHash: '0x1' });
    // completed is terminal — every re-use of the id is refused by the writer
    expect(await transitionDelegation(db.pool, d.id, ['completed'], 'accepted')).toBeNull();
    expect(await t.coordinator.markAccepted(d.id)).toBeNull();
    expect(await t.coordinator.markFailed(d.id, 'x')).toBeNull();
    expect((await getDelegation(db.pool, d.id))?.status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// Channel throttles (spec §3b bounds — compute-burn + approval-fatigue containment)
// ---------------------------------------------------------------------------

describe('channel throttles', () => {
  it('payload above DELEGATION_PAYLOAD_MAX_BYTES (16 KB default) → rejected + error trace', async () => {
    const { a } = await seedPair('auto');
    const payload = { blob: 'x'.repeat(17_000) };
    await expect(t.coordinator.issueDelegation({ fromAgent: a, kind: 'transfer.request', payload })).rejects.toMatchObject(
      { reason: 'delegation_payload_too_large', httpStatus: 413 },
    );
    const errs = tracesOfKind(await listTraces(db.pool, a.id), 'error');
    const detail = detailOf(errs[0]);
    expect(detail['reason']).toBe('delegation_payload_too_large');
    expect(detail['maxBytes']).toBe(16_384);
    // rejected BEFORE insert — no row exists
    expect((await listDelegations(db.pool, { agentId: a.id })).delegations).toEqual([]);
  });

  it('max concurrently-pending per link (3 default) → 4th rejected + traced', async () => {
    const { a } = await seedPair('auto');
    const issued: Delegation[] = [];
    for (let i = 0; i < 3; i++) {
      issued.push(await t.coordinator.issueDelegation({ fromAgent: a, kind: 'transfer.request', payload: { i } }));
    }
    await expect(
      t.coordinator.issueDelegation({ fromAgent: a, kind: 'transfer.request', payload: { i: 3 } }),
    ).rejects.toMatchObject({ reason: 'delegation_max_pending' });
    const errs = tracesOfKind(await listTraces(db.pool, a.id), 'error');
    expect(detailOf(errs[0])['reason']).toBe('delegation_max_pending');
    expect((await listDelegations(db.pool, { agentId: a.id })).delegations).toHaveLength(3);
    // accepting one frees a slot — the cap is on CONCURRENT pending, not total
    const first = issued[0];
    if (!first) throw new Error('unreachable');
    await t.coordinator.markAccepted(first.id);
    const ok = await t.coordinator.issueDelegation({ fromAgent: a, kind: 'transfer.request', payload: { i: 4 } });
    expect(ok.status).toBe('pending');
  });

  it('per-link hourly rate limit (override 2/h) → 3rd rejected + traced even after completion', async () => {
    t = buildTestApp(db.pool, {
      settings: testSettings({ delegationRatePerLinkPerHour: 2, delegationMaxPendingPerLink: 10 }),
    });
    const { a } = await seedPair('auto');
    const d1 = await t.coordinator.issueDelegation({ fromAgent: a, kind: 'transfer.request', payload: {} });
    await t.coordinator.markAccepted(d1.id);
    await t.coordinator.markCompleted(d1.id, { txHash: '0x1' }); // rate counts CREATED rows, all statuses
    await t.coordinator.issueDelegation({ fromAgent: a, kind: 'transfer.request', payload: {} });
    await expect(
      t.coordinator.issueDelegation({ fromAgent: a, kind: 'transfer.request', payload: {} }),
    ).rejects.toMatchObject({ reason: 'delegation_rate_limited', httpStatus: 429 });
    const errs = tracesOfKind(await listTraces(db.pool, a.id), 'error');
    expect(detailOf(errs[0])['reason']).toBe('delegation_rate_limited');
  });
});

// ---------------------------------------------------------------------------
// Link pause mid-flight + stopped receiver
// ---------------------------------------------------------------------------

describe('mid-flight semantics', () => {
  it('link pause: accepted (in-flight) survives, pending is cancelled + traced', async () => {
    const { a, linkId } = await seedPair('auto');
    const inflight = await t.coordinator.issueDelegation({ fromAgent: a, kind: 'transfer.request', payload: { n: 1 } });
    const queued = await t.coordinator.issueDelegation({ fromAgent: a, kind: 'transfer.request', payload: { n: 2 } });
    await t.coordinator.markAccepted(inflight.id);

    const res = await request(t.app)
      .post(`/api/links/${linkId}`)
      .set('authorization', ownerAuth(OWNER))
      .send({ action: 'pause' });
    expect(res.status).toBe(200);

    expect((await getDelegation(db.pool, inflight.id))?.status).toBe('accepted'); // spec §4 NOTE
    expect((await getDelegation(db.pool, queued.id))?.status).toBe('cancelled');
    const updates = tracesOfKind(await listTraces(db.pool, a.id), 'delegation_update');
    const cancelledTrace = updates.find((r) => detailOf(r)['delegationId'] === queued.id);
    expect(detailOf(cancelledTrace)['status']).toBe('cancelled');
    // the in-flight one still completes normally afterwards
    const done = await t.coordinator.markCompleted(inflight.id, { txHash: '0x2' });
    expect(done?.status).toBe('completed');
  });

  it('delegation to a stopped receiver stays pending and activatable within TTL', async () => {
    const { a, b } = await seedPair('auto');
    // FakeRuntime is not running b — the nudge is recorded but delivers nothing
    expect(t.runtime.isRunning(b.id)).toBe(false);
    const d = await t.coordinator.issueDelegation({ fromAgent: a, kind: 'transfer.request', payload: {} });
    expect(t.runtime.nudges).toEqual([b.id]);
    expect((await getDelegation(db.pool, d.id))?.status).toBe('pending');
    // still there for pickup on next start (poll = correctness path)
    const activatable = await listActivatablePendingFor(db.pool, b.id);
    expect(activatable.map((r) => r.id)).toContain(d.id);
  });
});

// ---------------------------------------------------------------------------
// Revoke fan-out over the coordination layer
// ---------------------------------------------------------------------------

describe('revoke during coordination', () => {
  it('cancelForRevokedAgent: outbound cancelled, inbound pending declined, inbound accepted failed(revoked) — all traced', async () => {
    const events = spyHub(t);
    const a = await seedFullAgent(OWNER, 'peer-a');
    const b = await seedFullAgent(OWNER, 'peer-b');
    const c = await seedFullAgent(OWNER, 'peer-c');
    await createLink(db.pool, { ownerAddr: OWNER, fromAgentId: b.id, toAgentId: a.id, mode: 'auto' });
    await createLink(db.pool, { ownerAddr: OWNER, fromAgentId: a.id, toAgentId: b.id, mode: 'auto' });
    await createLink(db.pool, { ownerAddr: OWNER, fromAgentId: c.id, toAgentId: b.id, mode: 'auto' });

    const outbound = await t.coordinator.issueDelegation({ fromAgent: b, kind: 'transfer.request', payload: {} });
    const inboundPending = await t.coordinator.issueDelegation({ fromAgent: a, kind: 'transfer.request', payload: {} });
    const inboundAccepted = await t.coordinator.issueDelegation({ fromAgent: c, kind: 'transfer.request', payload: {} });
    await t.coordinator.markAccepted(inboundAccepted.id);

    await t.coordinator.cancelForRevokedAgent(b.id);

    expect((await getDelegation(db.pool, outbound.id))?.status).toBe('cancelled');
    expect((await getDelegation(db.pool, inboundPending.id))?.status).toBe('declined');
    const failed = await getDelegation(db.pool, inboundAccepted.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.result).toEqual({ error: 'revoked' });

    // all three transitions traced on the REVOKED agent's chain
    const updates = tracesOfKind(await listTraces(db.pool, b.id), 'delegation_update');
    const byId = new Map(updates.map((r) => [detailOf(r)['delegationId'], detailOf(r)['status']]));
    expect(byId.get(outbound.id)).toBe('cancelled');
    expect(byId.get(inboundPending.id)).toBe('declined');
    expect(byId.get(inboundAccepted.id)).toBe('failed');

    // counterparties see the transitions over SSE
    for (const [agentId, delegationId, status] of [
      [a.id, outbound.id, 'cancelled'],
      [a.id, inboundPending.id, 'declined'],
      [c.id, inboundAccepted.id, 'failed'],
    ] as const) {
      expect(
        events.some(
          (e) => e.event === 'delegation' && e.agentId === agentId && e.data['delegationId'] === delegationId && e.data['status'] === status,
        ),
      ).toBe(true);
    }
  });

  it('the single revoke route cancels the revoked agent open delegations (fan-out wiring)', async () => {
    const { a } = await seedPair('auto');
    const d = await t.coordinator.issueDelegation({ fromAgent: a, kind: 'transfer.request', payload: {} });
    const res = await request(t.app).post(`/api/agents/${a.id}/revoke`).set('authorization', ownerAuth(OWNER)).send({});
    expect(res.status).toBe(200);
    expect((await getDelegation(db.pool, d.id))?.status).toBe('cancelled');
  });

  it('applyRevokeFanout without a coordinator (pre-coordination callers) still works', async () => {
    const a = await seedFullAgent();
    await applyRevokeFanout({ pool: db.pool, hub: t.hub, runtime: t.runtime }, a.id, 'onchain-event');
    const row = await db.pool.query(`SELECT status FROM agents WHERE id = $1`, [a.id]);
    expect(row.rows[0]?.status).toBe('revoked');
  });
});

// ---------------------------------------------------------------------------
// POST /api/agents/revoke-batch
// ---------------------------------------------------------------------------

describe('POST /api/agents/revoke-batch', () => {
  it('revokes multiple agents: on-chain + fan-out + delegation cancellation per agent', async () => {
    const { a, b } = await seedPair('auto');
    const d = await t.coordinator.issueDelegation({ fromAgent: a, kind: 'transfer.request', payload: {} });
    const res = await request(t.app)
      .post('/api/agents/revoke-batch')
      .set('authorization', ownerAuth(OWNER))
      .send({ agentIds: [a.id, b.id] });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    for (const r of res.body.results) {
      expect(r.ok).toBe(true);
      expect(r.txHash).toBeDefined();
    }
    expect(t.chain.revoked).toEqual([a.accountAddr, b.accountAddr]);
    expect(t.runtime.halted).toEqual(expect.arrayContaining([a.id, b.id]));
    for (const id of [a.id, b.id]) {
      const row = await db.pool.query(`SELECT status FROM agents WHERE id = $1`, [id]);
      expect(row.rows[0]?.status).toBe('revoked');
    }
    expect((await getDelegation(db.pool, d.id))?.status).toBe('cancelled');
  });

  it('partial failure is honest: failed agent gets C-2 shape, NOT marked revoked, runtime halted, error traced', async () => {
    const a = await seedFullAgent();
    const b = await seedFullAgent();
    t.chain.revokeErrorFor.add(a.accountAddr.toLowerCase());
    const res = await request(t.app)
      .post('/api/agents/revoke-batch')
      .set('authorization', ownerAuth(OWNER))
      .send({ agentIds: [a.id, b.id] });
    expect(res.status).toBe(200);
    const [ra, rb] = res.body.results;
    expect(ra).toMatchObject({
      agentId: a.id,
      ok: false,
      error: 'guardian_revoke_failed',
      ownerRevokeFallback: { accountAddr: a.accountAddr, method: 'revoke()' },
    });
    expect(rb).toMatchObject({ agentId: b.id, ok: true });
    // failed one: DB still active (hard boundary armed), runtime halted, error traced
    const row = await db.pool.query(`SELECT status FROM agents WHERE id = $1`, [a.id]);
    expect(row.rows[0]?.status).toBe('active');
    expect(t.runtime.halted).toContain(a.id);
    const errs = tracesOfKind(await listTraces(db.pool, a.id), 'error');
    expect(errs.length).toBeGreaterThan(0);
  });

  it('ANY foreign id → 403 whole request, nothing revoked', async () => {
    const mine = await seedFullAgent(OWNER);
    const theirs = await seedFullAgent(OTHER_OWNER);
    const res = await request(t.app)
      .post('/api/agents/revoke-batch')
      .set('authorization', ownerAuth(OWNER))
      .send({ agentIds: [mine.id, theirs.id] });
    expect(res.status).toBe(403);
    expect(t.chain.revoked).toEqual([]);
    const row = await db.pool.query(`SELECT status FROM agents WHERE id = $1`, [mine.id]);
    expect(row.rows[0]?.status).toBe('active');
  });

  it('rejects >16 ids and an empty list with 400', async () => {
    const a = await seedFullAgent();
    const many = Array.from({ length: 17 }, () => a.id);
    expect(
      (
        await request(t.app)
          .post('/api/agents/revoke-batch')
          .set('authorization', ownerAuth(OWNER))
          .send({ agentIds: many })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(t.app)
          .post('/api/agents/revoke-batch')
          .set('authorization', ownerAuth(OWNER))
          .send({ agentIds: [] })
      ).status,
    ).toBe(400);
  });

  it('already-revoked agents are idempotent: { ok:true, alreadyRevoked:true }, no second tx', async () => {
    const a = await seedFullAgent();
    await request(t.app).post(`/api/agents/${a.id}/revoke`).set('authorization', ownerAuth(OWNER)).send({});
    expect(t.chain.revoked).toHaveLength(1);
    const res = await request(t.app)
      .post('/api/agents/revoke-batch')
      .set('authorization', ownerAuth(OWNER))
      .send({ agentIds: [a.id] });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ agentId: a.id, ok: true, alreadyRevoked: true }]);
    expect(t.chain.revoked).toHaveLength(1); // no new on-chain call
  });
});

// ---------------------------------------------------------------------------
// GET /api/agents (fleet list) + PATCH /api/agents/:id/rules
// ---------------------------------------------------------------------------

describe('GET /api/agents', () => {
  const FLEET_OWNER = '0x' + '7f'.repeat(20);

  it('pages the owner fleet newest-first and never leaks foreign agents', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await seedFullAgent(FLEET_OWNER, `fleet-${i}`)).id);
    await seedFullAgent(OTHER_OWNER, 'foreign');

    const page1 = await request(t.app).get('/api/agents?limit=2').set('authorization', ownerAuth(FLEET_OWNER));
    expect(page1.status).toBe(200);
    expect(page1.body.agents).toHaveLength(2);
    expect(page1.body.nextCursor).toBeDefined();
    const page2 = await request(t.app)
      .get(`/api/agents?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`)
      .set('authorization', ownerAuth(FLEET_OWNER));
    expect(page2.body.agents).toHaveLength(1);
    expect(page2.body.nextCursor).toBeUndefined();

    const seen = [...page1.body.agents, ...page2.body.agents].map((a: { agentId: string }) => a.agentId);
    expect(new Set(seen)).toEqual(new Set(ids)); // exactly the fleet, nothing foreign
  });

  it('returns the AgentSummary shape with live balances', async () => {
    const agent = await seedFullAgent(FLEET_OWNER, 'balance-check');
    t.chain.balances.set(agent.accountAddr.toLowerCase(), 12_345n);
    const res = await request(t.app).get('/api/agents').set('authorization', ownerAuth(FLEET_OWNER));
    const agents = res.body.agents as Array<Record<string, unknown>>;
    const summary = agents.find((a) => a['agentId'] === agent.id);
    expect(summary).toMatchObject({
      agentId: agent.id,
      name: agent.name,
      status: 'active',
      accountAddr: agent.accountAddr,
      sessionKeyAddr: agent.sessionKeyAddr,
      accountBalanceWei: '12345',
      createdAt: agent.createdAt,
    });
    // no secret material in the fleet list
    expect(summary?.['sessionKeyEnc']).toBeUndefined();
    expect(summary?.['tokenHash']).toBeUndefined();
  });
});

describe('PATCH /api/agents/:id/rules', () => {
  it('replaces the rules, traces config with original+effective, and the change is visible on GET', async () => {
    const agent = await seedFullAgent(OWNER, 'rules-agent');
    await db.pool.query(`UPDATE agents SET gateway_rules = $2 WHERE id = $1`, [
      agent.id,
      JSON.stringify([{ action: 'block', match: 'old-rule' }]),
    ]);
    const rules = [
      { action: 'block', match: 'forbidden' },
      { action: 'modify', match: 'secret', replacement: '[redacted]' },
    ];
    const res = await request(t.app)
      .patch(`/api/agents/${agent.id}/rules`)
      .set('authorization', ownerAuth(OWNER))
      .send({ rules });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, rules });

    // rules actually replaced (visible on a subsequent read)
    const detail = await request(t.app).get(`/api/agents/${agent.id}`).set('authorization', ownerAuth(OWNER));
    expect(detail.body.agent.gatewayRules).toEqual(rules);

    // 'config' trace carries BOTH original and effective (original+effective discipline)
    const cfg = tracesOfKind(await listTraces(db.pool, agent.id), 'config');
    expect(cfg).toHaveLength(1);
    expect(cfg[0]?.originalRequest).toEqual({ rules: [{ action: 'block', match: 'old-rule' }] });
    expect(cfg[0]?.effectiveRequest).toEqual({ rules });
  });

  it('rejects >RULES_MAX rules with the C-1 error shape and invalid shapes with 400', async () => {
    const agent = await seedFullAgent(OWNER, 'rules-limit');
    const many = Array.from({ length: 33 }, (_, i) => ({ action: 'block', match: `r${i}` }));
    const over = await request(t.app)
      .patch(`/api/agents/${agent.id}/rules`)
      .set('authorization', ownerAuth(OWNER))
      .send({ rules: many });
    expect(over.status).toBe(400);
    expect(over.body).toEqual({ error: 'too_many_rules', max: 32 });
    const bad = await request(t.app)
      .patch(`/api/agents/${agent.id}/rules`)
      .set('authorization', ownerAuth(OWNER))
      .send({ rules: [{ action: 'explode', match: 'x' }] });
    expect(bad.status).toBe(400);
  });

  it('enforces ownership (403 foreign) like every owner route', async () => {
    const agent = await seedFullAgent(OWNER, 'rules-authz');
    const res = await request(t.app)
      .patch(`/api/agents/${agent.id}/rules`)
      .set('authorization', ownerAuth(OTHER_OWNER))
      .send({ rules: [] });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// GET /api/delegations — owner-scoped feed
// ---------------------------------------------------------------------------

describe('GET /api/delegations', () => {
  it('filters by agentId or linkId, pages created_at DESC, and enforces ownership', async () => {
    const { a, b, linkId } = await seedPair('auto');
    // rate default is 12/h — 3 issues fit; complete each so max-pending never trips
    for (let i = 0; i < 3; i++) {
      const d = await t.coordinator.issueDelegation({ fromAgent: a, kind: 'transfer.request', payload: { i } });
      await t.coordinator.markAccepted(d.id);
      await t.coordinator.markCompleted(d.id, { txHash: `0x${i}` });
    }

    const byAgent = await request(t.app)
      .get(`/api/delegations?agentId=${b.id}`)
      .set('authorization', ownerAuth(OWNER));
    expect(byAgent.status).toBe(200);
    expect(byAgent.body.delegations).toHaveLength(3);

    const byLink = await request(t.app)
      .get(`/api/delegations?linkId=${linkId}`)
      .set('authorization', ownerAuth(OWNER));
    expect(byLink.body.delegations).toHaveLength(3);

    // neither filter → 400
    expect((await request(t.app).get('/api/delegations').set('authorization', ownerAuth(OWNER))).status).toBe(400);

    // foreign owner probing my agent/link → 403
    expect(
      (await request(t.app).get(`/api/delegations?agentId=${a.id}`).set('authorization', ownerAuth(OTHER_OWNER)))
        .status,
    ).toBe(403);
    expect(
      (await request(t.app).get(`/api/delegations?linkId=${linkId}`).set('authorization', ownerAuth(OTHER_OWNER)))
        .status,
    ).toBe(403);
  });

  it('keyset cursor walks the feed without gaps or repeats', async () => {
    const { a } = await seedPair('auto');
    const wanted: string[] = [];
    for (let i = 0; i < 5; i++) {
      const d = await t.coordinator.issueDelegation({ fromAgent: a, kind: 'job.run', payload: { i } });
      await t.coordinator.markAccepted(d.id); // keep pending count under the cap
      wanted.push(d.id);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listDelegations(db.pool, { agentId: a.id, limit: 2, ...(cursor !== undefined ? { cursor } : {}) });
      seen.push(...page.delegations.map((d) => d.id));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(wanted));
  });
});

// ---------------------------------------------------------------------------
// State machine — the single transition writer is the only door
// ---------------------------------------------------------------------------

describe('delegation state machine (transition writer)', () => {
  async function freshDelegation(status: DelegationStatus): Promise<Delegation> {
    const { a, b, linkId } = await seedPair('auto');
    const d = await createDelegation(db.pool, {
      linkId,
      fromAgentId: a.id,
      toAgentId: b.id,
      kind: 'transfer.request',
      payload: {},
      status: 'pending',
      expiresAt: new Date(Date.now() + 60_000),
    });
    if (status === 'pending') return d;
    // walk the row to the requested status THROUGH the writer only
    const walk: Record<string, Array<{ from: DelegationStatus[]; to: DelegationStatus }>> = {
      pending_approval: [], // seeded directly below
      accepted: [{ from: ['pending'], to: 'accepted' }],
      completed: [
        { from: ['pending'], to: 'accepted' },
        { from: ['accepted'], to: 'completed' },
      ],
      failed: [
        { from: ['pending'], to: 'accepted' },
        { from: ['accepted'], to: 'failed' },
      ],
      declined: [{ from: ['pending'], to: 'declined' }],
      cancelled: [{ from: ['pending'], to: 'cancelled' }],
      expired: [{ from: ['pending'], to: 'expired' }],
    };
    let row: Delegation | null = d;
    for (const step of walk[status] ?? []) {
      row = await transitionDelegation(db.pool, d.id, step.from, step.to);
      expect(row).not.toBeNull();
    }
    return row as Delegation;
  }

  it('every legal transition succeeds exactly once', async () => {
    const legal: Array<{ from: DelegationStatus; to: DelegationStatus }> = [
      { from: 'pending', to: 'accepted' },
      { from: 'pending', to: 'declined' },
      { from: 'pending', to: 'cancelled' },
      { from: 'pending', to: 'expired' },
      { from: 'accepted', to: 'completed' },
      { from: 'accepted', to: 'failed' },
    ];
    for (const { from, to } of legal) {
      const d = await freshDelegation(from);
      const first = await transitionDelegation(db.pool, d.id, [from], to);
      expect(first?.status, `${from} → ${to}`).toBe(to);
      // exactly once: replaying the same transition loses
      const replay = await transitionDelegation(db.pool, d.id, [from], to);
      expect(replay, `${from} → ${to} replay`).toBeNull();
    }
  });

  it('pending_approval: approve/deny/expire/cancel all gate on the pending_approval status', async () => {
    const { a, b, linkId } = await seedPair('supervised');
    for (const to of ['pending', 'declined', 'expired', 'cancelled'] as const) {
      const d = await createDelegation(db.pool, {
        linkId,
        fromAgentId: a.id,
        toAgentId: b.id,
        kind: 'transfer.request',
        payload: {},
        status: 'pending_approval',
        expiresAt: new Date(Date.now() + 60_000),
      });
      const done = await transitionDelegation(db.pool, d.id, ['pending_approval'], to);
      expect(done?.status).toBe(to);
      expect(await transitionDelegation(db.pool, d.id, ['pending_approval'], to)).toBeNull();
    }
  });

  it('refuses illegal transitions: expired→accepted, completed→failed, cancelled→pending, pending→completed', async () => {
    const expired = await freshDelegation('expired');
    expect(await transitionDelegation(db.pool, expired.id, ['pending'], 'accepted')).toBeNull();

    const completed = await freshDelegation('completed');
    expect(await transitionDelegation(db.pool, completed.id, ['accepted'], 'failed')).toBeNull();

    const cancelled = await freshDelegation('cancelled');
    expect(await transitionDelegation(db.pool, cancelled.id, ['cancelled'], 'pending')).toBeNull();
    expect(await transitionDelegation(db.pool, cancelled.id, ['pending_approval', 'accepted'], 'pending')).toBeNull();

    // completed only from accepted — pending can never skip straight there
    const pending = await freshDelegation('pending');
    expect(await transitionDelegation(db.pool, pending.id, ['accepted'], 'completed')).toBeNull();
    expect((await getDelegation(db.pool, pending.id))?.status).toBe('pending');
  });

  it('typed CoordinationError carries reason + httpStatus for the API layer', () => {
    const err = new CoordinationError('delegation_rate_limited', 429);
    expect(err.reason).toBe('delegation_rate_limited');
    expect(err.httpStatus).toBe(429);
    expect(err.name).toBe('CoordinationError');
  });
});

// ---------------------------------------------------------------------------
// Gate fixes: orphaned-accepted boot sweep · dangling supervised approval ·
// concurrent markAccepted race · M-03 guardian resync
// ---------------------------------------------------------------------------
describe('gate fixes', () => {
  it('boot sweep fails orphaned ACCEPTED rows (crashed mid-cycle) terminally + traced', async () => {
    const { a, b, linkId } = await seedPair();
    const d = await createDelegation(db.pool, {
      linkId,
      fromAgentId: a.id,
      toAgentId: b.id,
      kind: 'transfer.request',
      payload: { probe: 'orphan' },
      status: 'pending',
      expiresAt: new Date(Date.now() + 600_000),
    });
    await t.deps.coordinator.markAccepted(d.id);

    const swept = await runBootSweep(db.pool, t.hub);
    const mine = swept.find((s) => s.id === d.id);
    expect(mine?.status).toBe('failed');
    expect(mine?.result).toEqual({ error: 'orphaned by restart' });
    const traces = tracesOfKind(await listTraces(db.pool, b.id), 'delegation_update');
    expect(traces.some((r) => String(detailOf(r)['summary']).includes('orphaned by restart'))).toBe(true);
  });

  it('sweeping an expired supervised delegation expires its dangling approval chain-visibly', async () => {
    const { a, b, linkId } = await seedPair('supervised');
    void b;
    void linkId;
    const agentA = await getAgentById(db.pool, a.id);
    if (!agentA) throw new Error('seed failed');
    const short = new DelegationCoordinator({
      pool: db.pool,
      hub: t.hub,
      runtime: { nudge: () => undefined },
      settings: {
        delegationTtlMs: 100, // expires almost immediately
        delegationRatePerLinkPerHour: 100,
        delegationMaxPendingPerLink: 10,
        delegationPayloadMaxBytes: 16_384,
      },
    });
    const d = await short.issueDelegation({ fromAgent: agentA, kind: 'transfer.request', payload: { x: 1 } });
    expect(d.status).toBe('pending_approval');
    const approvalRow = await db.pool.query(
      `SELECT id FROM approvals WHERE agent_id = $1 AND state = 'pending' AND request_ref->>'delegationId' = $2`,
      [a.id, d.id],
    );
    expect(approvalRow.rowCount).toBe(1);

    await new Promise((r) => setTimeout(r, 200));
    await short.sweepOnce();

    expect((await getDelegation(db.pool, d.id))?.status).toBe('expired');
    const after = await db.pool.query(`SELECT state FROM approvals WHERE id = $1`, [approvalRow.rows[0].id]);
    expect(after.rows[0].state).toBe('expired'); // no dangling card
    const consents = tracesOfKind(await listTraces(db.pool, a.id), 'consent');
    expect(
      consents.some(
        (c) => c.approvalId === approvalRow.rows[0].id && c.decision === 'expired' && c.decidedBy === 'system',
      ),
    ).toBe(true);
  });

  it('CONCURRENT markAccepted race: exactly one winner (test-quality gate)', async () => {
    const { a, b, linkId } = await seedPair();
    const d = await createDelegation(db.pool, {
      linkId,
      fromAgentId: a.id,
      toAgentId: b.id,
      kind: 'transfer.request',
      payload: { probe: 'race' },
      status: 'pending',
      expiresAt: new Date(Date.now() + 600_000),
    });
    const results = await Promise.all([
      t.deps.coordinator.markAccepted(d.id),
      t.deps.coordinator.markAccepted(d.id),
      t.deps.coordinator.markAccepted(d.id),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('M-03: a failed guardian revoke resyncs guardian_addr from chain', async () => {
    const owner = OWNER;
    const res = await request(t.app)
      .post('/api/agents')
      .set('authorization', ownerAuth(owner))
      .send({
        name: 'resync-agent',
        auditPubKey: '04' + 'cd'.repeat(64),
        policy: {
          perTransferCapWei: '10000000000000000',
          windowCapWei: '30000000000000000',
          windowSeconds: 3600,
          expiresAt: Math.floor(Date.now() / 1000) + 86_400,
        },
        allowlist: ['0x' + '9c'.repeat(20)],
        goal: { beneficiary: '0x' + '9c'.repeat(20), targetBalanceWei: '1', topUpWei: '1' },
        encryptedAuditKey: 'blob',
      });
    expect(res.status).toBe(201);
    const agentId = res.body.agentId as string;
    const accountAddr = (res.body.accountAddr as string).toLowerCase();

    // Owner replaced the guardian on-chain (setGuardian) — LEASH's row is stale.
    const newGuardian = '0x' + 'fe'.repeat(20);
    t.chain.onchainGuardians.set(accountAddr, newGuardian);
    t.chain.revokeError = new Error('execution reverted: NotGuardianOrOwner');

    const rev = await request(t.app)
      .post(`/api/agents/${agentId}/revoke`)
      .set('authorization', ownerAuth(owner))
      .send({});
    expect(rev.status).toBe(502);
    expect(rev.body.ok).toBe(false);

    const row = await db.pool.query(`SELECT guardian_addr, status FROM agents WHERE id = $1`, [agentId]);
    expect(row.rows[0].guardian_addr).toBe(newGuardian); // self-healed
    expect(row.rows[0].status).toBe('active'); // still NOT marked revoked (C-2)
  });
});
