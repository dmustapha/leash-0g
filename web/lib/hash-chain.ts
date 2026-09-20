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

export function recordHash(record: Omit<TraceRecord, 'hash'>): Hex {
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
export function verifyChain(records: TraceRecord[], expectedPrev?: Hex): ChainResult {
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
    if (recordHash(body) !== hash) {
      return { ok: false, brokenAtSeq: r.seq, reason: 'hash-mismatch' };
    }
    prev = hash;
    lastSeq = r.seq;
  }
  return { ok: true, count: records.length };
}

/** Parse a decrypted JSONL audit batch into records (skips blank lines). */
export function parseJsonl(text: string): TraceRecord[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TraceRecord);
}
