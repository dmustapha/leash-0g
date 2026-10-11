import type { Pool, PoolClient } from 'pg';
import { verifyChain, type VerifyResult, type ChainedRecord } from '../crypto/hashchain.js';
import { appendChained, appendChainedInTx, OWNER_CHAIN } from './chained.js';
import { getPruneCheckpoint } from './audit-prune.js';
import type { Json } from '../crypto/canonical.js';
import type { OwnerRecord, OwnerRecordKind } from '../types.js';

/**
 * The per-OWNER hash-chained record stream (spec §3d) — the 0G-logged daily
 * loop. Mirrors trace_records via the SHARED chained helper: same seq/prevHash
 * /hash discipline, same advisory-lock serialization, same append-only
 * triggers. Boundary DECISIONS stay consent records on the AGENT chain
 * (authoritative); owner records reference them, never duplicate authority.
 *
 * Records append from seq 0 regardless of key state (S10): encryption happens
 * at BATCH time — the batcher defers until the owner-stream pubkey exists,
 * then drains the full backlog. No unlogged gap.
 */

function buildOwnerRecord(
  ownerAddr: string,
  kind: OwnerRecordKind,
  record: Json,
): (seq: number, prevHash: string) => Omit<OwnerRecord, 'hash'> {
  return (seq, prevHash) => ({
    ownerAddr: ownerAddr.toLowerCase(),
    seq,
    prevHash,
    ts: new Date().toISOString(),
    kind,
    record,
  });
}

/** Append inside the caller's transaction (the alert-emit atomic core, §3b). */
export async function appendOwnerRecordInTx(
  client: PoolClient,
  ownerAddr: string,
  kind: OwnerRecordKind,
  record: Json,
): Promise<OwnerRecord> {
  return appendChainedInTx<OwnerRecord>(
    client,
    OWNER_CHAIN,
    ownerAddr.toLowerCase(),
    buildOwnerRecord(ownerAddr, kind, record),
  );
}

/** Standalone append (own transaction). */
export async function appendOwnerRecord(
  pool: Pool,
  ownerAddr: string,
  kind: OwnerRecordKind,
  record: Json,
): Promise<OwnerRecord> {
  return appendChained<OwnerRecord>(
    pool,
    OWNER_CHAIN,
    ownerAddr.toLowerCase(),
    buildOwnerRecord(ownerAddr, kind, record),
  );
}

export async function listOwnerRecords(
  pool: Pool,
  ownerAddr: string,
  opts: { afterSeq?: number; limit?: number } = {},
): Promise<OwnerRecord[]> {
  const res = await pool.query<{ record: OwnerRecord }>(
    `SELECT record FROM owner_records WHERE owner_addr = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
    [ownerAddr.toLowerCase(), opts.afterSeq ?? -1, Math.min(opts.limit ?? 100, 500)],
  );
  return res.rows.map((r) => r.record);
}

/**
 * Recompute + verify the owner's full stored chain. Checkpoint-aware
 * (SCOPE-I-6): mirrors verifyAgentChain — if the prefix has been pruned to 0G,
 * an audit_prune_checkpoint anchors the retained suffix (verify from
 * checkpoint.seq+1 expecting checkpoint.hash); else genesis.
 */
export async function verifyOwnerChain(db: Pool | PoolClient, ownerAddr: string): Promise<VerifyResult> {
  const key = ownerAddr.toLowerCase();
  const checkpoint = await getPruneCheckpoint(db, 'owner', key);
  const res = await db.query<{ record: OwnerRecord }>(
    `SELECT record FROM owner_records WHERE owner_addr = $1 AND seq > $2 ORDER BY seq ASC`,
    [key, checkpoint ? checkpoint.seq : -1],
  );
  const records = res.rows.map((r) => r.record as unknown as ChainedRecord);
  return checkpoint
    ? verifyChain(records, { expectFirstSeq: checkpoint.seq + 1, expectPrevHash: checkpoint.hash })
    : verifyChain(records);
}

// Incremental verification cache — same soundness argument as trace_records
// (append-only trigger ⇒ a verified prefix cannot change).
const verifiedHeads = new Map<string, { seq: number; hash: string }>();

/** Test hook — reset the per-process verification cache. */
export function _clearOwnerVerifyCache(): void {
  verifiedHeads.clear();
}

export async function verifyOwnerChainIncremental(db: Pool | PoolClient, ownerAddr: string): Promise<VerifyResult> {
  const key = ownerAddr.toLowerCase();
  const cached = verifiedHeads.get(key);
  // SCOPE-I-6: anchor from whichever is LATER — the cached head or the durable
  // prune checkpoint (a cached head below a pruned prefix is stale; a fresh
  // process must anchor from the checkpoint, not a vanished genesis).
  const checkpoint = await getPruneCheckpoint(db, 'owner', key);
  const anchor =
    cached && (!checkpoint || cached.seq >= checkpoint.seq) ? cached : (checkpoint ?? null);
  const res = await db.query<{ record: OwnerRecord }>(
    `SELECT record FROM owner_records WHERE owner_addr = $1 AND seq > $2 ORDER BY seq ASC`,
    [key, anchor ? anchor.seq : -1],
  );
  const records = res.rows.map((r) => r.record as unknown as ChainedRecord);
  const verdict = anchor
    ? verifyChain(records, { expectFirstSeq: anchor.seq + 1, expectPrevHash: anchor.hash })
    : verifyChain(records);
  if (!verdict.ok) {
    verifiedHeads.delete(key);
    return verdict;
  }
  const last = records[records.length - 1];
  if (last) verifiedHeads.set(key, { seq: last.seq, hash: last.hash });
  return verdict;
}
