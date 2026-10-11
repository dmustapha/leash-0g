import type { Pool, PoolClient } from 'pg';
import { verifyChain, type VerifyResult } from '../crypto/hashchain.js';
import { appendChained, TRACE_CHAIN } from '../store/chained.js';
import { getPruneCheckpoint } from '../store/audit-prune.js';
import type { Json } from '../crypto/canonical.js';
import type { TraceKind, TraceRecord, X0gTrace } from '../types.js';

export interface AppendTraceInput {
  agentId: string;
  kind: TraceKind;
  ts?: string;
  originalRequest?: Json;
  effectiveRequest?: Json;
  response?: Json;
  x0gTrace?: X0gTrace;
  approvalId?: string;
  decision?: 'approve' | 'deny' | 'expired';
  decidedBy?: 'owner' | 'system';
  detail?: Json;
}

/**
 * Append one record to the agent's tamper-evident chain via the SHARED
 * chained-append helper (store/chained.ts — one implementation, two tables;
 * owner_records is the other): per-agent monotonic seq + hash =
 * sha256(prevHash || canonicalJSON(record)), advisory-lock-serialized.
 * Resolves only after the row is durably committed — callers that must order
 * side effects after the write (consent-before-forward) await this.
 */
// SE-7 (carry from SE-5 Gate-② review): trace_records.chain_id is intentionally
// left UNSET here (nullable, backfilled to 0G by migration 020) — traces are
// agent_id-scoped so cross-chain isolation is already inherent. When the first real
// 2nd chain lands (SE-7), thread the agent's chainId through the generic chained
// append so chain-scoped audit reads are populated, then SET NOT NULL + index it.
export async function appendTrace(pool: Pool, input: AppendTraceInput): Promise<TraceRecord> {
  return appendChained<TraceRecord>(pool, TRACE_CHAIN, input.agentId, (seq, prevHash) =>
    buildRecord(input, seq, prevHash),
  );
}

function buildRecord(input: AppendTraceInput, seq: number, prevHash: string): Omit<TraceRecord, 'hash'> {
  const body: Omit<TraceRecord, 'hash'> = {
    agentId: input.agentId,
    seq,
    prevHash,
    ts: input.ts ?? new Date().toISOString(),
    kind: input.kind,
    ...(input.originalRequest !== undefined ? { originalRequest: input.originalRequest } : {}),
    ...(input.effectiveRequest !== undefined ? { effectiveRequest: input.effectiveRequest } : {}),
    ...(input.response !== undefined ? { response: input.response } : {}),
    ...(input.x0gTrace !== undefined ? { x0gTrace: input.x0gTrace } : {}),
    ...(input.approvalId !== undefined ? { approvalId: input.approvalId } : {}),
    ...(input.decision !== undefined ? { decision: input.decision } : {}),
    ...(input.decidedBy !== undefined ? { decidedBy: input.decidedBy } : {}),
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
  };
  return body;
}

export interface ListOptions {
  afterSeq?: number;
  limit?: number;
}

export async function listTraces(pool: Pool, agentId: string, opts: ListOptions = {}): Promise<TraceRecord[]> {
  const res = await pool.query<{ record: TraceRecord }>(
    `SELECT record FROM trace_records WHERE agent_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
    [agentId, opts.afterSeq ?? -1, Math.min(opts.limit ?? 100, 500)],
  );
  return res.rows.map((r) => r.record);
}

/**
 * Recompute + verify the agent's full stored chain (used by API + tests).
 * Checkpoint-aware (SCOPE-I-6): if the prefix has been pruned to 0G, an
 * audit_prune_checkpoint anchors the retained suffix — verify from
 * checkpoint.seq+1 expecting checkpoint.hash instead of genesis. Rows at or
 * below the checkpoint are excluded so the anchor lines up even mid-prune.
 */
export async function verifyAgentChain(db: Pool | PoolClient, agentId: string): Promise<VerifyResult> {
  const checkpoint = await getPruneCheckpoint(db, 'trace', agentId);
  const res = await db.query<{ record: TraceRecord }>(
    'SELECT record FROM trace_records WHERE agent_id = $1 AND seq > $2 ORDER BY seq ASC',
    [agentId, checkpoint ? checkpoint.seq : -1],
  );
  const records = res.rows.map((r) => r.record as unknown as import('../crypto/hashchain.js').ChainedRecord);
  return checkpoint
    ? verifyChain(records, { expectFirstSeq: checkpoint.seq + 1, expectPrevHash: checkpoint.hash })
    : verifyChain(records);
}

// L-04: /traces polls verification on every request — O(full chain) per poll
// grows unboundedly. Cache the last VERIFIED head per agent and verify only
// records appended since. Sound because the DB trigger makes trace_records
// append-only (UPDATE/DELETE rejected): a verified prefix cannot change.
// Cache is per-process; a restart or failure just falls back to one full scan.
const verifiedHeads = new Map<string, { seq: number; hash: string }>();

/** Test hook — reset the per-process verification cache. */
export function _clearVerifyCache(): void {
  verifiedHeads.clear();
}

export async function verifyAgentChainIncremental(
  db: Pool | PoolClient,
  agentId: string,
): Promise<VerifyResult> {
  const cached = verifiedHeads.get(agentId);
  // SCOPE-I-6: anchor from whichever is LATER — the cached verified head or the
  // durable prune checkpoint. A cached head at/below a pruned prefix is stale
  // (its row is gone), so fall back to the checkpoint; with no cache (fresh
  // process) the checkpoint is the genesis-substitute, else a seq-0 scan on a
  // pruned chain would spuriously fail.
  const checkpoint = await getPruneCheckpoint(db, 'trace', agentId);
  const anchor =
    cached && (!checkpoint || cached.seq >= checkpoint.seq) ? cached : (checkpoint ?? null);
  const res = await db.query<{ record: TraceRecord }>(
    'SELECT record FROM trace_records WHERE agent_id = $1 AND seq > $2 ORDER BY seq ASC',
    [agentId, anchor ? anchor.seq : -1],
  );
  const records = res.rows.map(
    (r) => r.record as unknown as import('../crypto/hashchain.js').ChainedRecord,
  );
  const verdict = anchor
    ? verifyChain(records, { expectFirstSeq: anchor.seq + 1, expectPrevHash: anchor.hash })
    : verifyChain(records);
  if (!verdict.ok) {
    verifiedHeads.delete(agentId); // next call re-scans from genesis
    return verdict;
  }
  const last = records[records.length - 1];
  if (last) verifiedHeads.set(agentId, { seq: last.seq, hash: last.hash });
  return verdict;
}
