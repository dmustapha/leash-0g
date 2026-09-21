// File: web/lib/hash-chain.ts
// Client-side verification of the tamper-evident trace chain (spec §4):
//   record.hash = sha256( prevHashBytes(32) || utf8(canonicalJSON(record minus hash)) )
// prevHash is decoded to its 32 RAW BYTES (not hashed as a hex string) — this
// matches backend/src/crypto/hashchain.ts computeRecordHash exactly.
// Canonical JSON = keys sorted recursively, undefined dropped, no whitespace.

import { hexToBytes, sha256 } from 'viem';
import type { Hex, TraceRecord } from './types';

export const GENESIS_HASH: Hex = `0x${'0'.repeat(64)}`;

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** Anything hash-chained the backend way: trace records AND Phase-3 owner records. */
export type ChainedRecord = { seq: number; prevHash: Hex; hash: Hex };

export function recordHash(record: { prevHash: Hex } & Record<string, unknown>): Hex {
  const prev = hexToBytes(record.prevHash as Hex); // 32 raw bytes, backend contract
  const body = new TextEncoder().encode(canonicalJson(record));
  const bytes = new Uint8Array(prev.length + body.length);
  bytes.set(prev, 0);
  bytes.set(body, prev.length);
  return sha256(bytes);
}

export type ChainResult =
  | { ok: true; count: number }
  | { ok: false; brokenAtSeq: number; reason: 'hash-mismatch' | 'link-mismatch' | 'seq-gap' };

/** Verify an ordered slice of records. `prevHash` of the first record links to what came before. */
export function verifyChain<T extends ChainedRecord>(records: T[], expectedPrev?: Hex): ChainResult {
  let prev = expectedPrev;
  let lastSeq: number | undefined;
  for (const r of records) {
    if (lastSeq !== undefined && r.seq !== lastSeq + 1) {
      return { ok: false, brokenAtSeq: r.seq, reason: 'seq-gap' };
    }
    if (prev !== undefined && r.prevHash !== prev) {
      return { ok: false, brokenAtSeq: r.seq, reason: 'link-mismatch' };
    }
    const { hash, ...body } = r;
    // Safe: T extends ChainedRecord, so `body` always carries prevHash.
    if (recordHash(body as { prevHash: Hex } & Record<string, unknown>) !== hash) {
      return { ok: false, brokenAtSeq: r.seq, reason: 'hash-mismatch' };
    }
    prev = hash;
    lastSeq = r.seq;
  }
  return { ok: true, count: records.length };
}

/** Where a verified batch's chain is anchored: all the way from seq 0, or a mid-chain slice. */
export type BatchChainResult =
  | { ok: true; count: number; anchored: 'genesis' | 'slice' }
  | Extract<ChainResult, { ok: false }>;

/** Anchors left by previously verified batches, keyed by the next expected seq. */
export type ChainAnchors = Map<number, { lastHash: Hex; fromGenesis: boolean }>;

/**
 * Verify one decrypted batch, threading expectedPrev across batches: the batch with
 * seqFrom === 0 anchors at GENESIS_HASH (backend/src/crypto/hashchain.ts); later batches
 * anchor at the previous batch's last record hash when that batch has been verified.
 * On success the batch's own tail is recorded in `anchors` for the next batch.
 */
export function verifyBatch<T extends ChainedRecord>(
  records: T[],
  seqFrom: number,
  anchors: ChainAnchors,
): BatchChainResult {
  const anchor =
    seqFrom === 0 ? { lastHash: GENESIS_HASH, fromGenesis: true } : anchors.get(seqFrom);
  const result = verifyChain(records, anchor?.lastHash);
  if (!result.ok) return result;
  const fromGenesis = anchor?.fromGenesis ?? false;
  const last = records[records.length - 1];
  if (last) anchors.set(last.seq + 1, { lastHash: last.hash, fromGenesis });
  return { ok: true, count: result.count, anchored: fromGenesis ? 'genesis' : 'slice' };
}

/** Parse a decrypted JSONL audit batch into records (skips blank lines). */
export function parseJsonl<T = TraceRecord>(text: string): T[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}
