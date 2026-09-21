import type { Pool, PoolClient } from 'pg';
import { GENESIS_HASH, computeRecordHash } from '../crypto/hashchain.js';

/**
 * THE shared hash-chain append discipline (spec §3d: "one implementation, two
 * tables"): per-scope monotonic seq + hash = sha256(prevHash ||
 * canonicalJSON(record-without-hash)), serialized by a transaction-scoped
 * advisory lock on the scope so seq can never gap or collide. trace_records
 * (per agent) and owner_records (per owner) both append through here.
 */
export interface ChainTableSpec {
  table: 'trace_records' | 'owner_records';
  scopeColumn: 'agent_id' | 'owner_addr';
  /** Advisory-lock namespace — MUST stay stable per table (trace: / owner:). */
  lockPrefix: string;
}

export const TRACE_CHAIN: ChainTableSpec = { table: 'trace_records', scopeColumn: 'agent_id', lockPrefix: 'trace' };
export const OWNER_CHAIN: ChainTableSpec = { table: 'owner_records', scopeColumn: 'owner_addr', lockPrefix: 'owner' };

export interface ChainedRow {
  seq: number;
  prevHash: string;
  hash: string;
  ts: string;
  kind: string;
}

/**
 * Append inside an EXISTING transaction (the caller owns BEGIN/COMMIT — this
 * is what lets an alert row and its owner-stream record commit atomically,
 * spec §3b "atomic core"). Takes the advisory lock, reads the head, builds the
 * record via `build(seq, prevHash)` (which must return the full body WITHOUT
 * `hash`, including seq/prevHash/ts/kind), hashes, inserts.
 */
export async function appendChainedInTx<T extends ChainedRow>(
  client: PoolClient,
  spec: ChainTableSpec,
  scopeValue: string,
  build: (seq: number, prevHash: string) => Omit<T, 'hash'>,
): Promise<T> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 42))', [
    `${spec.lockPrefix}:${scopeValue}`,
  ]);
  const head = await client.query<{ seq: string; hash: string }>(
    `SELECT seq, hash FROM ${spec.table} WHERE ${spec.scopeColumn} = $1 ORDER BY seq DESC LIMIT 1`,
    [scopeValue],
  );
  const prevSeq = head.rows[0] ? Number(head.rows[0].seq) : -1;
  const prevHash = head.rows[0]?.hash ?? GENESIS_HASH;
  const body = build(prevSeq + 1, prevHash);
  const hash = computeRecordHash(prevHash, body);
  const record = { ...body, hash } as T;
  await client.query(
    `INSERT INTO ${spec.table} (${spec.scopeColumn}, seq, prev_hash, hash, ts, kind, record)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [scopeValue, record.seq, record.prevHash, record.hash, record.ts, record.kind, JSON.stringify(record)],
  );
  return record;
}

/** Standalone append — owns its own transaction (the common single-record path). */
export async function appendChained<T extends ChainedRow>(
  pool: Pool,
  spec: ChainTableSpec,
  scopeValue: string,
  build: (seq: number, prevHash: string) => Omit<T, 'hash'>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const record = await appendChainedInTx<T>(client, spec, scopeValue, build);
    await client.query('COMMIT');
    return record;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
