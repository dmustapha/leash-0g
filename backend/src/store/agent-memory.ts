import type { Pool } from 'pg';
import type { Json } from '../crypto/canonical.js';

/**
 * The thin per-agent working-memory log (spec §5, S23). Agent-authored =>
 * QUARANTINED-UNTRUSTED: the read-only status summary reads it but it is never
 * authority. A bounded rolling window — append the newest, prune the oldest.
 * Seq allocation is serialized per agent under an advisory lock (the runtime
 * loop is single-writer per agent, but the lock makes it race-safe regardless).
 */
export interface AgentMemoryEntry {
  agentId: string;
  seq: number;
  ts: string;
  kind: string;
  content: Json;
}

interface DbMemoryRow {
  agent_id: string;
  seq: string;
  ts: Date;
  kind: string;
  content: Json;
}

function mapRow(r: DbMemoryRow): AgentMemoryEntry {
  return { agentId: r.agent_id, seq: Number(r.seq), ts: r.ts.toISOString(), kind: r.kind, content: r.content };
}

/** Advisory-lock key from the agent uuid (stable per agent). */
function lockKey(agentId: string): string {
  return `agent_memory:${agentId}`;
}

export async function appendMemory(
  pool: Pool,
  input: { agentId: string; kind: string; content: Json },
  windowCap = 200,
): Promise<AgentMemoryEntry> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 64-bit key space (hashtextextended) for parity with the trace/consent chain
    // lock (store/chained.ts) — avoids the smaller 32-bit hashtext collision space.
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 42))`, [lockKey(input.agentId)]);
    const head = await client.query<{ seq: string }>(
      `SELECT COALESCE(max(seq), -1)::text AS seq FROM agent_memory WHERE agent_id = $1`,
      [input.agentId],
    );
    const nextSeq = Number(head.rows[0]?.seq ?? '-1') + 1;
    const ins = await client.query<DbMemoryRow>(
      `INSERT INTO agent_memory (agent_id, seq, ts, kind, content)
       VALUES ($1, $2, now(), $3, $4) RETURNING agent_id, seq, ts, kind, content`,
      [input.agentId, nextSeq, input.kind, JSON.stringify(input.content)],
    );
    // Prune the rolling window: keep only the newest `windowCap` entries.
    await client.query(
      `DELETE FROM agent_memory WHERE agent_id = $1 AND seq <= $2::bigint - $3::bigint`,
      [input.agentId, nextSeq, windowCap],
    );
    await client.query('COMMIT');
    const row = ins.rows[0];
    if (!row) throw new Error('agent_memory insert failed');
    return mapRow(row);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Newest-first recent memory entries (for the status summary). */
export async function listRecentMemory(pool: Pool, agentId: string, limit = 50): Promise<AgentMemoryEntry[]> {
  const res = await pool.query<DbMemoryRow>(
    `SELECT agent_id, seq, ts, kind, content FROM agent_memory
     WHERE agent_id = $1 ORDER BY seq DESC LIMIT $2`,
    [agentId, Math.min(limit, 200)],
  );
  return res.rows.map(mapRow);
}

export async function countMemory(pool: Pool, agentId: string): Promise<number> {
  const res = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM agent_memory WHERE agent_id = $1`, [agentId]);
  return Number(res.rows[0]?.n ?? 0);
}
