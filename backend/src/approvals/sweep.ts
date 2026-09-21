import type { Pool } from 'pg';
import { appendTrace } from '../trace/trace-store.js';
import type { TraceRecord } from '../types.js';

/**
 * C-6 startup sweep: after a crash/restart every held request and paused run
 * is gone (the broker is in-memory), so ANY still-`pending` approval row is an
 * orphan — nobody will ever deliver its decision. Expire them terminally and
 * chain-visibly (consent-class record, decidedBy system) so the audit trail
 * never shows an approval that silently vanished.
 *
 * Phase-2 coordination adds the matching delegation sweep (see
 * coordination/store.ts `sweepExpiredDelegations`) — both run at boot.
 */
export async function sweepOrphanedApprovals(pool: Pool): Promise<TraceRecord[]> {
  const res = await pool.query<{ id: string; agent_id: string; request_ref: unknown }>(
    `UPDATE approvals SET state = 'expired', decided_at = now()
     WHERE state = 'pending'
     RETURNING id, agent_id, request_ref`,
  );
  const traces: TraceRecord[] = [];
  for (const row of res.rows) {
    traces.push(
      await appendTrace(pool, {
        agentId: row.agent_id,
        kind: 'consent',
        approvalId: row.id,
        decision: 'expired',
        decidedBy: 'system',
        originalRequest: row.request_ref as never,
        detail: { reason: 'orphaned pending approval swept at startup' },
      }),
    );
  }
  return traces;
}
