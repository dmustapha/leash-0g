import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { PrivateKey } from 'eciesjs';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { buildTestApp, ownerAuth } from '../helpers/app.js';
import { createLink, createDelegation, getDelegation, setLinkStatus } from '../../src/coordination/store.js';
import { createApproval } from '../../src/store/approvals.js';
import { getAgentById } from '../../src/store/agents.js';
import { listTraces } from '../../src/trace/trace-store.js';

/**
 * Gate-② debt P2–P4 (spec §2a): delegation↔approval ownership binding,
 * server-side sentinel spend-incapability, pickup link-status re-check.
 */

let db: TestDb;
let ownerCounter = 0;
function uniqueOwner(): string {
  return '0x8d' + String(ownerCounter++).padStart(4, '0') + 'cd'.repeat(17);
}
const auditKey = new PrivateKey();

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

async function seedSupervisedDelegation(owner: string): Promise<{
  fromId: string;
  toId: string;
  linkId: string;
  delegationId: string;
}> {
  const fromId = await seedAgent(db.pool, { ownerAddr: owner, name: 'issuer' });
  const toId = await seedAgent(db.pool, { ownerAddr: owner, name: 'receiver' });
  const link = await createLink(db.pool, { ownerAddr: owner, fromAgentId: fromId, toAgentId: toId, mode: 'supervised' });
  const d = await createDelegation(db.pool, {
    linkId: link.id,
    fromAgentId: fromId,
    toAgentId: toId,
    kind: 'task',
    payload: { note: 'supervised' },
    status: 'pending_approval',
    expiresAt: new Date(Date.now() + 600_000),
  });
  return { fromId, toId, linkId: link.id, delegationId: d.id };
}

describe('P2 — delegation↔approval ownership binding (P3C-2)', () => {
  it('a mismatched approval agent cannot transition a foreign delegation (no-op + error trace)', async () => {
    const owner = uniqueOwner();
    const t = buildTestApp(db.pool);
    const { delegationId } = await seedSupervisedDelegation(owner);
    const strangerOwner = uniqueOwner();
    const strangerId = await seedAgent(db.pool, { ownerAddr: strangerOwner, name: 'stranger' });

    const result = await t.coordinator.onDelegationApprovalDecision(delegationId, 'approve', strangerId);
    expect(result).toBeNull();
    const d = await getDelegation(db.pool, delegationId);
    expect(d?.status).toBe('pending_approval'); // unmoved
    const traces = await listTraces(db.pool, strangerId);
    const err = traces.find(
      (r) => r.kind === 'error' && (r.detail as { reason?: string })?.reason === 'delegation_approval_mismatch',
    );
    expect(err).toBeDefined();
  });

  it('a forged approval requestRef naming a foreign delegation cannot activate it via the API', async () => {
    const owner = uniqueOwner();
    const t = buildTestApp(db.pool);
    const { delegationId } = await seedSupervisedDelegation(owner);
    // Same OWNER, different agent: an approval on an unrelated agent whose
    // requestRef names the delegation. Pre-P3C-2 this activated the envelope.
    const unrelatedId = await seedAgent(db.pool, { ownerAddr: owner, name: 'unrelated' });
    const approval = await createApproval(db.pool, unrelatedId, {
      type: 'delegation',
      delegationId,
      kind: 'task',
    });
    const res = await request(t.app)
      .post(`/api/approvals/${approval.id}`)
      .set('authorization', ownerAuth(owner))
      .send({ decision: 'approve' });
    expect(res.status).toBe(200); // the approval itself decides fine…
    const d = await getDelegation(db.pool, delegationId);
    expect(d?.status).toBe('pending_approval'); // …but the foreign envelope is unmoved
  });

  it('the legitimate issuer approval still activates the envelope (regression)', async () => {
    const owner = uniqueOwner();
    const t = buildTestApp(db.pool);
    const { fromId, delegationId } = await seedSupervisedDelegation(owner);
    const approval = await createApproval(db.pool, fromId, { type: 'delegation', delegationId, kind: 'task' });
    const res = await request(t.app)
      .post(`/api/approvals/${approval.id}`)
      .set('authorization', ownerAuth(owner))
      .send({ decision: 'approve' });
    expect(res.status).toBe(200);
    const d = await getDelegation(db.pool, delegationId);
    expect(d?.status).toBe('pending'); // activated for delivery
  });
});

describe('P3 — server-side sentinel spend-incapability (P3C-3)', () => {
  function sentinelBody(policy: { perTransferCapWei: string; windowCapWei: string }, allowlist: string[]) {
    return {
      name: 'sentinel-x',
      auditPubKey: auditKey.publicKey.toHex(),
      policy: { ...policy, windowSeconds: 3600, expiresAt: Math.floor(Date.now() / 1000) + 86_400 },
      allowlist,
      goal: {
        type: 'sentinel',
        beneficiary: '0x' + '9c'.repeat(20),
        targetBalanceWei: '50000000000000000',
        topUpWei: '5000000000000000',
      },
    };
  }

  it('a spend-capable "sentinel" create is rejected 400 sentinel_must_be_spend_incapable', async () => {
    const owner = uniqueOwner();
    const t = buildTestApp(db.pool);
    for (const body of [
      sentinelBody({ perTransferCapWei: '10000000000000000', windowCapWei: '0' }, []),
      sentinelBody({ perTransferCapWei: '0', windowCapWei: '30000000000000000' }, []),
      sentinelBody({ perTransferCapWei: '0', windowCapWei: '0' }, ['0x' + '9c'.repeat(20)]),
    ]) {
      const res = await request(t.app).post('/api/agents').set('authorization', ownerAuth(owner)).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('sentinel_must_be_spend_incapable');
    }
  });

  it('the spend-incapable sentinel preset still creates (FE preset unchanged)', async () => {
    const owner = uniqueOwner();
    const t = buildTestApp(db.pool);
    const res = await request(t.app)
      .post('/api/agents')
      .set('authorization', ownerAuth(owner))
      .send(sentinelBody({ perTransferCapWei: '0', windowCapWei: '0' }, []));
    expect(res.status).toBe(201);
  });
});

describe('P4 — pickup re-checks link status (P3C-4)', () => {
  it('an envelope pending on a paused link is cancelled at pickup and traced on both chains', async () => {
    const owner = uniqueOwner();
    const t = buildTestApp(db.pool);
    const { fromId, toId, linkId, delegationId } = await seedSupervisedDelegation(owner);
    // Simulate the pause race: the envelope goes pending AFTER the pause's
    // cancel pass already ran (direct status flip, no cancelForLink).
    await db.pool.query(`UPDATE delegations SET status = 'pending' WHERE id = $1`, [delegationId]);
    await setLinkStatus(db.pool, linkId, 'paused');

    const cancelled = await t.coordinator.cancelInactiveLinkPickups(toId);
    expect(cancelled.map((d) => d.id)).toContain(delegationId);
    const d = await getDelegation(db.pool, delegationId);
    expect(d?.status).toBe('cancelled');
    for (const agentId of [fromId, toId]) {
      const traces = await listTraces(db.pool, agentId);
      expect(
        traces.some(
          (r) =>
            r.kind === 'delegation_update' &&
            String((r.detail as { summary?: string })?.summary).includes('cancelled at pickup'),
        ),
        `chain of ${agentId}`,
      ).toBe(true);
    }
  });

  it('the pickup query itself never returns a paused-link envelope', async () => {
    const owner = uniqueOwner();
    const { toId, linkId, delegationId } = await seedSupervisedDelegation(owner);
    await db.pool.query(`UPDATE delegations SET status = 'pending' WHERE id = $1`, [delegationId]);
    await setLinkStatus(db.pool, linkId, 'paused');
    const { listActivatablePendingFor } = await import('../../src/coordination/store.js');
    const rows = await listActivatablePendingFor(db.pool, toId);
    expect(rows.map((r) => r.id)).not.toContain(delegationId);
  });

  it('an already-accepted envelope on a paused link runs to completion (spec §4 NOTE holds)', async () => {
    const owner = uniqueOwner();
    const t = buildTestApp(db.pool);
    const { toId, linkId, delegationId } = await seedSupervisedDelegation(owner);
    await db.pool.query(`UPDATE delegations SET status = 'accepted' WHERE id = $1`, [delegationId]);
    await setLinkStatus(db.pool, linkId, 'paused');
    const cancelled = await t.coordinator.cancelInactiveLinkPickups(toId);
    expect(cancelled).toHaveLength(0);
    const completed = await t.coordinator.markCompleted(delegationId, { txHash: '0x' + 'ee'.repeat(32) });
    expect(completed?.status).toBe('completed');
    // sanity: the agent row still exists for FK integrity of the trace above
    expect(await getAgentById(db.pool, toId)).not.toBeNull();
  });
});

describe('Gate-① build note 2 — supervised TTL restarts at decision time', () => {
  it('an approve near the deadline extends the envelope past its original expiry', async () => {
    const owner = uniqueOwner();
    const t = buildTestApp(db.pool);
    const { fromId, delegationId } = await seedSupervisedDelegation(owner);
    // Simulate deciding at the buzzer: 5s left of a 600s TTL.
    await db.pool.query(`UPDATE delegations SET expires_at = now() + interval '5 seconds' WHERE id = $1`, [
      delegationId,
    ]);
    const d = await t.coordinator.onDelegationApprovalDecision(delegationId, 'approve', fromId);
    expect(d?.status).toBe('pending');
    const row = await db.pool.query<{ expires_at: Date }>(`SELECT expires_at FROM delegations WHERE id = $1`, [
      delegationId,
    ]);
    const remainingMs = (row.rows[0]?.expires_at.getTime() ?? 0) - Date.now();
    // Restarted from the DECISION time: a full TTL window remains, not 5s.
    expect(remainingMs).toBeGreaterThan(500_000);
  });

  it('a deny does NOT touch expiry (declined envelopes stay terminal)', async () => {
    const owner = uniqueOwner();
    const t = buildTestApp(db.pool);
    const { fromId, delegationId } = await seedSupervisedDelegation(owner);
    const before = await db.pool.query<{ expires_at: Date }>(`SELECT expires_at FROM delegations WHERE id = $1`, [
      delegationId,
    ]);
    const d = await t.coordinator.onDelegationApprovalDecision(delegationId, 'deny', fromId);
    expect(d?.status).toBe('declined');
    const after = await db.pool.query<{ expires_at: Date }>(`SELECT expires_at FROM delegations WHERE id = $1`, [
      delegationId,
    ]);
    expect(after.rows[0]?.expires_at.getTime()).toBe(before.rows[0]?.expires_at.getTime());
  });
});
