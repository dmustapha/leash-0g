import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical.js';

/** hash = sha256(prevHashBytes || canonicalJSON(record-without-hash)) — spec §4. */
export const GENESIS_HASH = `0x${'00'.repeat(32)}`;

export interface ChainedRecord {
  seq: number;
  prevHash: string;
  hash: string;
  [key: string]: unknown;
}

export function computeRecordHash(prevHash: string, recordWithoutHash: Record<string, unknown>): string {
  const prev = Buffer.from(prevHash.replace(/^0x/, ''), 'hex');
  if (prev.length !== 32) throw new Error('computeRecordHash: prevHash must be 32 bytes');
  const body = Buffer.from(canonicalJson(recordWithoutHash), 'utf8');
  return `0x${createHash('sha256').update(Buffer.concat([prev, body])).digest('hex')}`;
}

export type VerifyResult = { ok: true } | { ok: false; badSeq: number; reason: string };

/**
 * Verify a contiguous slice of an agent's chain. By default the slice is
 * expected to start at seq 0 from the genesis hash; pass expectations to
 * verify a mid-chain slice.
 */
export function verifyChain(
  records: readonly ChainedRecord[],
  opts: { expectFirstSeq?: number; expectPrevHash?: string } = {},
): VerifyResult {
  let expectedSeq = opts.expectFirstSeq ?? 0;
  let expectedPrev = opts.expectPrevHash ?? GENESIS_HASH;
  for (const record of records) {
    if (record.seq !== expectedSeq) {
      return { ok: false, badSeq: record.seq, reason: `seq gap: expected ${expectedSeq}, got ${record.seq}` };
    }
    if (record.prevHash !== expectedPrev) {
      return { ok: false, badSeq: record.seq, reason: 'prevHash does not link to previous record' };
    }
    const { hash, ...body } = record;
    const recomputed = computeRecordHash(record.prevHash, body);
    if (recomputed !== hash) {
      return { ok: false, badSeq: record.seq, reason: 'record hash mismatch (content mutated)' };
    }
    expectedPrev = hash;
    expectedSeq += 1;
  }
  return { ok: true };
}
