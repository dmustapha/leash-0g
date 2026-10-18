import { describe, it, expect } from 'vitest';
import { buildPoaRecord, poaFromJobRow } from '../../src/jobs/poa.js';
import type { JobRow } from '../../src/store/jobs.js';

/**
 * `poaFromJobRow` was extracted out of `jobs/graph.ts` so the graph and the
 * settlement sweep could not drift into minting two DIFFERENT permanent PoAs
 * for the same job. These tests lock the extraction: identical to the inline
 * code it replaced, and identical across both nullability shapes.
 */

const TX = '0x' + 'dd'.repeat(32);

const FULL = {
  jobId: 'job-1',
  jobSpecHash: '0x' + 'ab'.repeat(32),
  requesterSig: '0x' + '11'.repeat(65),
  deliverableRoot: '0x' + 'cd'.repeat(32),
  providerSig: '0x' + '22'.repeat(65),
  verdict: 'accept' as const,
  evaluatorSig: '0x' + '33'.repeat(65),
  acceptance: { passed: true, failures: [], checked: 4 },
} satisfies Parameters<typeof poaFromJobRow>[0];

describe('poaFromJobRow', () => {
  it('matches the record the inline graph code built, field for field', () => {
    expect(poaFromJobRow(FULL, TX)).toEqual(
      buildPoaRecord({
        jobId: FULL.jobId,
        jobSpecHash: FULL.jobSpecHash,
        requesterSig: FULL.requesterSig,
        deliverableRoot: FULL.deliverableRoot,
        providerSig: FULL.providerSig,
        verdict: FULL.verdict,
        evaluatorSig: FULL.evaluatorSig,
        acceptance: FULL.acceptance,
        settlementTx: TX,
      }),
    );
  });

  it('applies the same fallbacks for a sparse row, and records absence as absence', () => {
    const sparse: Parameters<typeof poaFromJobRow>[0] = {
      ...FULL,
      deliverableRoot: null,
      providerSig: null,
      verdict: null,
      evaluatorSig: null,
      acceptance: null,
    };
    const poa = poaFromJobRow(sparse, TX);
    expect(poa.deliverableRoot).toBe('');
    expect(poa.providerSig).toBe('');
    expect(poa.evaluatorSig).toBe('');
    // Settlement is only ever reached through an accepted verdict, so a null
    // here is a projection gap, not a rejection.
    expect(poa.verdict).toBe('accept');
    // "No structural check ran" — stated honestly, not as "checks passed".
    expect(poa.acceptance).toEqual({ passed: true, checked: 0, failureCount: 0 });
    expect(poa.settlementTx).toBe(TX);
  });

  it('never carries acceptance failure strings into the permanent record', () => {
    // Failure strings can echo untrusted deliverable text (F-quar / L-1); only
    // the structural count may enter the verified PoA.
    const poa = poaFromJobRow(
      { ...FULL, acceptance: { passed: false, failures: ['<script>from the deliverable</script>'], checked: 2 } },
      TX,
    );
    expect(poa.acceptance).toEqual({ passed: false, checked: 2, failureCount: 1 });
    expect(JSON.stringify(poa)).not.toContain('script');
  });

  it('accepts a full JobRow without widening its input type', () => {
    // Compile-time guard: the Pick<> in poaFromJobRow must stay satisfiable by
    // a real row, which is what both call sites actually pass.
    const row = FULL as unknown as JobRow;
    expect(poaFromJobRow(row, TX).jobId).toBe('job-1');
  });
});
