import type { Pool, PoolClient } from 'pg';

/**
 * SCOPE-I-6: the OPERATOR audit prune — delete chain rows already archived to
 * 0G and older than a retention window, WITHOUT breaking hash-chain
 * verification. The reusable core lives here so the integration test can drive
 * it in-process; scripts/prune-audit.mjs is a thin CLI wrapper (dry-run by
 * default, env parsing, --apply gate).
 *
 * Anchor invariant: a delete and its checkpoint upsert commit in the SAME txn
 * (pruneStream opens one transaction). We never delete chain prefix without
 * recording the (seq, hash) the retained suffix must link from. verifyChain is
 * made checkpoint-aware (trace-store / owner-records) so full verification
 * resumes from checkpoint.seq+1 expecting checkpoint.hash instead of genesis.
 */

export type Stream = 'trace' | 'owner';

export interface PruneCheckpoint {
  seq: number;
  hash: string;
}

/** The durable anchor for a stream+key, or null if nothing pruned yet. */
export async function getPruneCheckpoint(
  db: Pool | PoolClient,
  stream: Stream,
  key: string,
): Promise<PruneCheckpoint | null> {
  const res = await db.query<{ pruned_through_seq: string; pruned_through_hash: string }>(
    `SELECT pruned_through_seq, pruned_through_hash
       FROM audit_prune_checkpoint WHERE stream = $1 AND key = $2`,
    [stream, key],
  );
  const row = res.rows[0];
  if (!row) return null;
  return { seq: Number(row.pruned_through_seq), hash: row.pruned_through_hash };
}

/** Per-stream physical layout — the only table-specific knowledge the core needs. */
export interface StreamTables {
  stream: Stream;
  table: string; // 'trace_records' | 'owner_records'
  keyCol: string; // 'agent_id' | 'owner_addr'
  cursorTable: string; // 'audit_cursor' | 'owner_audit_cursor'
  triggerName: string; // 'trace_records_append_only' | 'owner_records_append_only'
}

export const TRACE_TABLES: StreamTables = {
  stream: 'trace',
  table: 'trace_records',
  keyCol: 'agent_id',
  cursorTable: 'audit_cursor',
  triggerName: 'trace_records_append_only',
};

export const OWNER_TABLES: StreamTables = {
  stream: 'owner',
  table: 'owner_records',
  keyCol: 'owner_addr',
  cursorTable: 'owner_audit_cursor',
  triggerName: 'owner_records_append_only',
};

export interface CutoffPlan {
  key: string;
  cutoffSeq: number;
  /** Rows at seq <= cutoffSeq that would be deleted (pre-apply count). */
  eligibleRows: number;
}

/**
 * For each key in the stream, the greatest seq that is BOTH archived to 0G
 * (seq <= last_batched_seq) AND older than the retention window
 * (created_at < now() - retention). Keys with nothing eligible are omitted.
 * Rows not yet batched (seq > last_batched_seq) are NEVER eligible even if old.
 */
export async function computeCutoffs(
  db: Pool | PoolClient,
  t: StreamTables,
  retentionDays: number,
): Promise<CutoffPlan[]> {
  const res = await db.query<{ key: string; cutoff_seq: string; eligible_rows: string }>(
    `SELECT r.${t.keyCol}::text AS key,
            MAX(r.seq) AS cutoff_seq,
            COUNT(*)   AS eligible_rows
       FROM ${t.table} r
       JOIN ${t.cursorTable} c ON c.${t.keyCol} = r.${t.keyCol}
      WHERE r.seq <= c.last_batched_seq
        AND r.created_at < now() - ($1 || ' days')::interval
      GROUP BY r.${t.keyCol}`,
    [String(retentionDays)],
  );
  return res.rows.map((row) => ({
    key: row.key,
    cutoffSeq: Number(row.cutoff_seq),
    eligibleRows: Number(row.eligible_rows),
  }));
}

export interface PruneResult {
  key: string;
  cutoffSeq: number;
  deleted: number;
  checkpointSeq: number;
}

/**
 * Prune one key up to cutoffSeq in ONE transaction: (a) read the row AT cutoff
 * for its hash; (b) upsert the checkpoint with GREATEST semantics (never moves
 * backward); (c) DISABLE the append-only trigger, DELETE seq <= cutoff, ENABLE
 * it; COMMIT. Checkpoint upsert + delete are atomic. Idempotent: a re-run finds
 * the rows already gone (0 deleted) and the checkpoint unchanged.
 *
 * Runs as ADMIN (MIGRATE_DATABASE_URL ?? DATABASE_URL) — the restricted runtime
 * role cannot DISABLE TRIGGER, so it can never prune (correct; INFRA-1). A
 * crash before COMMIT rolls back and restores the trigger.
 */
export async function pruneStream(
  client: PoolClient,
  t: StreamTables,
  plan: { key: string; cutoffSeq: number },
): Promise<PruneResult> {
  await client.query('BEGIN');
  try {
    const anchor = await client.query<{ hash: string }>(
      `SELECT record->>'hash' AS hash FROM ${t.table} WHERE ${t.keyCol} = $1 AND seq = $2`,
      [plan.key, plan.cutoffSeq],
    );
    const hash = anchor.rows[0]?.hash;
    if (!hash) {
      // Already pruned past this seq (idempotent re-run) — nothing to anchor or delete.
      await client.query('COMMIT');
      const cp = await getPruneCheckpoint(client, t.stream, plan.key);
      return { key: plan.key, cutoffSeq: plan.cutoffSeq, deleted: 0, checkpointSeq: cp?.seq ?? plan.cutoffSeq };
    }

    await client.query(
      `INSERT INTO audit_prune_checkpoint (stream, key, pruned_through_seq, pruned_through_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (stream, key) DO UPDATE
         SET pruned_through_seq = EXCLUDED.pruned_through_seq,
             pruned_through_hash = EXCLUDED.pruned_through_hash,
             pruned_at = now()
       WHERE EXCLUDED.pruned_through_seq > audit_prune_checkpoint.pruned_through_seq`,
      [t.stream, plan.key, plan.cutoffSeq, hash],
    );

    await client.query(`ALTER TABLE ${t.table} DISABLE TRIGGER ${t.triggerName}`);
    const del = await client.query(
      `DELETE FROM ${t.table} WHERE ${t.keyCol} = $1 AND seq <= $2`,
      [plan.key, plan.cutoffSeq],
    );
    await client.query(`ALTER TABLE ${t.table} ENABLE TRIGGER ${t.triggerName}`);

    await client.query('COMMIT');
    // computeCutoffs only ever yields a cutoff ABOVE any existing checkpoint, so
    // the just-committed checkpoint is plan.cutoffSeq (no re-read needed).
    return {
      key: plan.key,
      cutoffSeq: plan.cutoffSeq,
      deleted: del.rowCount ?? 0,
      checkpointSeq: plan.cutoffSeq,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}
