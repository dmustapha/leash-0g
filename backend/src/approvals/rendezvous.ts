import type { Pool } from 'pg';
import { ApprovalBroker, type ApprovalDecision } from './broker.js';
import { getApproval } from '../store/approvals.js';

export interface RendezvousDeps {
  pool: Pool;
  broker: ApprovalBroker;
}

/**
 * C-3: THE approval rendezvous — the ONE implementation of
 * register → check-durable → wait → recheck, shared by the gateway's
 * holdForApproval and the runtime's interrupt resume so the two can never
 * drift apart again (PHASE-1-REVIEW C-3).
 *
 * Why this shape: the broker only wakes a LIVE waiter. The owner's decision
 * can land durably in Postgres BEFORE the waiter registers (the API notifies
 * into the void while the gateway is still creating the approval row / the
 * graph is still checkpointing its interrupt). So: register the waiter FIRST,
 * then check the durable state (settling the dangling waiter if the decision
 * already landed), and re-check once more when the wait times out.
 *
 * Durability ordering: POST /api/approvals/:id commits the decision, THEN
 * appends the consent record, THEN notifies the broker. `decidedInDb` returns
 * a decision only once the consent record is durable — resuming earlier would
 * break consent-seq < action-seq. If the consent append is still in flight,
 * the broker notify (sent after the append) wakes the registered waiter.
 */
export async function awaitApprovalDecision(
  deps: RendezvousDeps,
  approvalId: string,
  timeoutMs: number,
): Promise<ApprovalDecision | 'timeout'> {
  const waited = deps.broker.wait(approvalId, timeoutMs);
  const early = await decidedInDb(deps.pool, approvalId);
  if (early) {
    deps.broker.notify(approvalId, early); // settle the dangling waiter
    return early;
  }
  const decision = await waited;
  if (decision !== 'timeout') return decision;
  return (await decidedInDb(deps.pool, approvalId)) ?? 'timeout';
}

/** Durable decision, gated on the consent record being persisted (see above). */
export async function decidedInDb(pool: Pool, approvalId: string): Promise<ApprovalDecision | null> {
  const row = await getApproval(pool, approvalId);
  if (!row || row.state === 'pending' || row.state === 'expired') return null;
  const consent = await pool.query(
    `SELECT 1 FROM trace_records WHERE agent_id = $1 AND kind = 'consent' AND record->>'approvalId' = $2`,
    [row.agentId, approvalId],
  );
  if (consent.rowCount === 0) return null;
  return {
    decision: row.state === 'approved' ? 'approve' : 'deny',
    ...(row.reason !== null ? { reason: row.reason } : {}),
  };
}
