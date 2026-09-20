import type { Pool } from 'pg';
import type { Json } from '../crypto/canonical.js';
import type { ApprovalRow } from '../types.js';

interface DbApprovalRow {
  id: string;
  agent_id: string;
  request_ref: Json;
  state: 'pending' | 'approved' | 'denied' | 'expired';
  reason: string | null;
  created_at: Date;
  decided_at: Date | null;
}

function mapRow(r: DbApprovalRow): ApprovalRow {
  return {
    id: r.id,
    agentId: r.agent_id,
    requestRef: r.request_ref,
    state: r.state,
    reason: r.reason,
    createdAt: r.created_at.toISOString(),
    decidedAt: r.decided_at ? r.decided_at.toISOString() : null,
  };
}

export async function createApproval(pool: Pool, agentId: string, requestRef: Json): Promise<ApprovalRow> {
  const res = await pool.query<DbApprovalRow>(
    `INSERT INTO approvals (agent_id, request_ref) VALUES ($1, $2) RETURNING *`,
    [agentId, JSON.stringify(requestRef)],
  );
  const row = res.rows[0];
  if (!row) throw new Error('approval insert failed');
  return mapRow(row);
}

export async function getApproval(pool: Pool, id: string): Promise<ApprovalRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const res = await pool.query<DbApprovalRow>(`SELECT * FROM approvals WHERE id = $1`, [id]);
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

/** Transition pending → approved/denied exactly once; returns null if already decided. */
export async function decideApproval(
  pool: Pool,
  id: string,
  decision: 'approve' | 'deny',
  reason?: string,
): Promise<ApprovalRow | null> {
  const res = await pool.query<DbApprovalRow>(
    `UPDATE approvals SET state = $2, reason = $3, decided_at = now()
     WHERE id = $1 AND state = 'pending' RETURNING *`,
    [id, decision === 'approve' ? 'approved' : 'denied', reason ?? null],
  );
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

/** Transition pending → expired (broker timeout); returns null if already decided. */
export async function expireApproval(pool: Pool, id: string): Promise<ApprovalRow | null> {
  const res = await pool.query<DbApprovalRow>(
    `UPDATE approvals SET state = 'expired', decided_at = now()
     WHERE id = $1 AND state = 'pending' RETURNING *`,
    [id],
  );
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}
