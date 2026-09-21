import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { ApprovalBroker } from '../../src/approvals/broker.js';
import { awaitApprovalDecision } from '../../src/approvals/rendezvous.js';
import { createApproval, decideApproval } from '../../src/store/approvals.js';
import { appendTrace } from '../../src/trace/trace-store.js';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

async function seedApproval(): Promise<{ agentId: string; approvalId: string }> {
  const agentId = await seedAgent(db.pool);
  const approval = await createApproval(db.pool, agentId, { probe: 'race' });
  return { agentId, approvalId: approval.id };
}

/** Simulate exactly what POST /api/approvals/:id persists, in its order. */
async function persistDecision(agentId: string, approvalId: string, decision: 'approve' | 'deny'): Promise<void> {
  await decideApproval(db.pool, approvalId, decision);
  await appendTrace(db.pool, {
    agentId,
    kind: 'consent',
    approvalId,
    decision,
    decidedBy: 'owner',
    originalRequest: { probe: 'race' },
  });
}

describe('C-3 shared approval rendezvous (register → check-durable → wait → recheck)', () => {
  it('race injection: decision persisted BEFORE the wait starts is still picked up', async () => {
    const { agentId, approvalId } = await seedApproval();
    // The owner's decision lands durably while no waiter exists (the exact
    // approve-recorded-but-never-forwarded race C-3 closes).
    await persistDecision(agentId, approvalId, 'approve');

    const broker = new ApprovalBroker();
    const started = Date.now();
    const decision = await awaitApprovalDecision({ pool: db.pool, broker }, approvalId, 30_000);
    expect(decision).toEqual({ decision: 'approve' });
    // Resolved via the durable check, not by burning the 30s wait.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('does NOT resume on a decision whose consent record is not yet durable', async () => {
    const { approvalId } = await seedApproval();
    // Decision committed but consent append still in flight — resuming now
    // would break consent-seq < action-seq.
    await decideApproval(db.pool, approvalId, 'approve');

    const broker = new ApprovalBroker();
    const decision = await awaitApprovalDecision({ pool: db.pool, broker }, approvalId, 400);
    // No consent, no notify → the helper must NOT have resumed early.
    expect(decision).toBe('timeout');
  });

  it('timeout re-check: a decision that landed without a notify wins over the timeout', async () => {
    const { agentId, approvalId } = await seedApproval();
    const broker = new ApprovalBroker();
    const pending = awaitApprovalDecision({ pool: db.pool, broker }, approvalId, 6_000);
    // Land the decision mid-wait WITHOUT notifying the broker (missed wake).
    // The early durable-check has already run by now (it fires immediately);
    // only the timeout re-check can save this decision.
    await new Promise((r) => setTimeout(r, 300));
    await persistDecision(agentId, approvalId, 'deny');
    const decision = await pending;
    expect(decision).toEqual({ decision: 'deny' });
  });

  it('live notify still wins immediately (the normal path)', async () => {
    const { approvalId } = await seedApproval();
    const broker = new ApprovalBroker();
    const pending = awaitApprovalDecision({ pool: db.pool, broker }, approvalId, 10_000);
    await new Promise((r) => setTimeout(r, 50));
    broker.notify(approvalId, { decision: 'approve', reason: 'live' });
    expect(await pending).toEqual({ decision: 'approve', reason: 'live' });
  });
});
