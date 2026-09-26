import type { Pool } from 'pg';
import type { AgentGoal } from '../types.js';
import type { DirectionDraft } from '../direction/direction.js';

/**
 * The conversational-direction read-back thread + lifecycle (spec §5). A row is
 * created in status `draft` by POST /direct (quarantined — no armed authority);
 * the owner's confirm moves it to `confirmed` (and appends the hash-chained
 * consent record); the runtime `sense_direction` step moves it to `applied`.
 * Confirming a directive SUPERSEDES any older confirmed-unapplied one for the
 * same agent, so only the latest intent is applied (superseded-skip, D-4).
 */
export type DirectionStatus = 'draft' | 'confirmed' | 'applied' | 'expired' | 'superseded';

export interface DirectionRow {
  id: string;
  agentId: string;
  ownerAddr: string;
  intent: string;
  answers: string[] | null;
  draft: DirectionDraft;
  effectiveGoal: AgentGoal | null;
  status: DirectionStatus;
  createdAt: string;
  confirmedAt: string | null;
  appliedAt: string | null;
}

interface DbDirectionRow {
  id: string;
  agent_id: string;
  owner_addr: string;
  intent: string;
  answers: string[] | null;
  draft: DirectionDraft;
  effective_goal: AgentGoal | null;
  status: DirectionStatus;
  created_at: Date;
  confirmed_at: Date | null;
  applied_at: Date | null;
}

function mapRow(r: DbDirectionRow): DirectionRow {
  return {
    id: r.id,
    agentId: r.agent_id,
    ownerAddr: r.owner_addr,
    intent: r.intent,
    answers: r.answers,
    draft: r.draft,
    effectiveGoal: r.effective_goal,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    confirmedAt: r.confirmed_at ? r.confirmed_at.toISOString() : null,
    appliedAt: r.applied_at ? r.applied_at.toISOString() : null,
  };
}

const COLS = `id, agent_id, owner_addr, intent, answers, draft, effective_goal, status, created_at, confirmed_at, applied_at`;

export async function insertDirectionDraft(
  pool: Pool,
  input: { agentId: string; ownerAddr: string; intent: string; answers?: string[] | undefined; draft: DirectionDraft },
): Promise<DirectionRow> {
  const res = await pool.query<DbDirectionRow>(
    `INSERT INTO directions (agent_id, owner_addr, intent, answers, draft, status)
     VALUES ($1,$2,$3,$4,$5,'draft') RETURNING ${COLS}`,
    [
      input.agentId,
      input.ownerAddr.toLowerCase(),
      input.intent,
      input.answers ? JSON.stringify(input.answers) : null,
      JSON.stringify(input.draft),
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('direction insert failed');
  return mapRow(row);
}

export async function getDirection(pool: Pool, id: string): Promise<DirectionRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const res = await pool.query<DbDirectionRow>(`SELECT ${COLS} FROM directions WHERE id = $1`, [id]);
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

/**
 * The sole authority-write transition for a directive: draft -> confirmed. A
 * compare-and-set (only from `draft`) so a double-confirm is a no-op returning
 * null. In the SAME transaction, supersedes any older confirmed-unapplied
 * directive for the agent (superseded-skip). Optionally overwrites the stored
 * draft with the owner-edited effective draft (edit-then-confirm).
 */
export async function confirmDirection(
  pool: Pool,
  id: string,
  effectiveGoal: AgentGoal,
  editedDraft?: DirectionDraft,
): Promise<DirectionRow | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query<DbDirectionRow>(
      `SELECT ${COLS} FROM directions WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const row = cur.rows[0];
    if (!row || row.status !== 'draft') {
      await client.query('ROLLBACK');
      return null;
    }
    // Supersede older confirmed-but-unapplied directives for this agent.
    await client.query(
      `UPDATE directions SET status = 'superseded'
       WHERE agent_id = $1 AND status = 'confirmed' AND id <> $2`,
      [row.agent_id, id],
    );
    const params: unknown[] = [id, JSON.stringify(effectiveGoal)];
    if (editedDraft) params.push(JSON.stringify(editedDraft));
    const upd = await client.query<DbDirectionRow>(
      `UPDATE directions SET status = 'confirmed', confirmed_at = now(), effective_goal = $2${editedDraft ? ', draft = $3' : ''}
       WHERE id = $1 RETURNING ${COLS}`,
      params,
    );
    await client.query('COMMIT');
    return upd.rows[0] ? mapRow(upd.rows[0]) : null;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Oldest-first confirmed-unapplied directives for the runtime `sense_direction` step. */
export async function listConfirmedUnapplied(pool: Pool, agentId: string, limit = 1): Promise<DirectionRow[]> {
  const res = await pool.query<DbDirectionRow>(
    `SELECT ${COLS} FROM directions WHERE agent_id = $1 AND status = 'confirmed'
     ORDER BY created_at ASC LIMIT $2`,
    [agentId, limit],
  );
  return res.rows.map(mapRow);
}

/** CAS confirmed -> applied (idempotent: a second apply returns null). */
export async function markDirectionApplied(pool: Pool, id: string): Promise<DirectionRow | null> {
  const res = await pool.query<DbDirectionRow>(
    `UPDATE directions SET status = 'applied', applied_at = now()
     WHERE id = $1 AND status = 'confirmed' RETURNING ${COLS}`,
    [id],
  );
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

/** Recent direction threads for an agent (cockpit display of the current directed intent). */
export async function listDirections(pool: Pool, agentId: string, limit = 20): Promise<DirectionRow[]> {
  const res = await pool.query<DbDirectionRow>(
    `SELECT ${COLS} FROM directions WHERE agent_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [agentId, limit],
  );
  return res.rows.map(mapRow);
}
