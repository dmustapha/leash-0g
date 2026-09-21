import type { Pool, PoolClient } from 'pg';
import { verifyChain, type VerifyResult } from '../crypto/hashchain.js';
import { appendChained, TRACE_CHAIN } from '../store/chained.js';
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

/** Recompute + verify the agent's full stored chain (used by API + tests). */
export async function verifyAgentChain(db: Pool | PoolClient, agentId: string): Promise<VerifyResult> {
  const res = await db.query<{ record: TraceRecord }>(
    'SELECT record FROM trace_records WHERE agent_id = $1 ORDER BY seq ASC',
    [agentId],
  );
  return verifyChain(res.rows.map((r) => r.record as unknown as import('../crypto/hashchain.js').ChainedRecord));
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
  const head = verifiedHeads.get(agentId);
  const res = await db.query<{ record: TraceRecord }>(
    'SELECT record FROM trace_records WHERE agent_id = $1 AND seq > $2 ORDER BY seq ASC',
    [agentId, head ? head.seq : -1],
  );
  const records = res.rows.map(
    (r) => r.record as unknown as import('../crypto/hashchain.js').ChainedRecord,
  );
  const verdict = head
    ? verifyChain(records, { expectFirstSeq: head.seq + 1, expectPrevHash: head.hash })
    : verifyChain(records);
  if (!verdict.ok) {
    verifiedHeads.delete(agentId); // next call re-scans from genesis
    return verdict;
  }
  const last = records[records.length - 1];
  if (last) verifiedHeads.set(agentId, { seq: last.seq, hash: last.hash });
  return verdict;
}
