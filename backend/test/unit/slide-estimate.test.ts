import { describe, it, expect } from 'vitest';
import { slideEstimate } from '../../src/chain/ops.js';

/**
 * AQ-FND Lane-B — the off-chain mirror of `PolicyLib.slide` (two-bucket sliding
 * window), pinned line-for-line against the contract math (PolicyLib.sol:135-159).
 * Observability only: the contract re-runs this at every debit and is the sole
 * enforcement; these cases keep the mirror honest.
 */
describe('slideEstimate — PolicyLib.slide mirror', () => {
  const W = 100;

  it('inside the current window: spent = prev-decay + cur', () => {
    // start=1000, now=1050 → offset 50 → prev contributes half
    const { spent, windowStart } = slideEstimate({ cur: 10n, prev: 40n, start: 1000 }, W, 1050);
    expect(windowStart).toBe(1000);
    expect(spent).toBe((40n * 50n) / 100n + 10n); // 30
  });

  it('one window elapsed: cur rolls to prev, start advances one bucket', () => {
    // elapsed 120 ∈ [w, 2w): prev=cur(10), cur=0, start+=w → offset 20
    const { spent, windowStart } = slideEstimate({ cur: 10n, prev: 40n, start: 1000 }, W, 1120);
    expect(windowStart).toBe(1100);
    expect(spent).toBe((10n * 80n) / 100n); // 8
  });

  it('two+ windows elapsed: both buckets zero, start re-aligned to the bucket grid', () => {
    // elapsed 250 ≥ 2w → start = now - (elapsed % w) = 1250 - 50 = 1200
    const { spent, windowStart } = slideEstimate({ cur: 10n, prev: 40n, start: 1000 }, W, 1250);
    expect(windowStart).toBe(1200);
    expect(spent).toBe(0n);
  });

  it('exact window boundary (elapsed == w) rolls the bucket (contract >= comparison)', () => {
    const { spent, windowStart } = slideEstimate({ cur: 7n, prev: 99n, start: 1000 }, W, 1100);
    expect(windowStart).toBe(1100);
    expect(spent).toBe(7n); // offset 0 → full prev(=old cur) weight: 7 * 100/100
  });

  it('exact double-window boundary (elapsed == 2w) resets both buckets on the grid (N-1)', () => {
    const { spent, windowStart } = slideEstimate({ cur: 10n, prev: 40n, start: 1000 }, W, 1200);
    expect(windowStart).toBe(1200); // elapsed % w == 0 → start = now
    expect(spent).toBe(0n);
  });

  it('an unstarted meter (start=0) or zero window returns cur unchanged', () => {
    expect(slideEstimate({ cur: 0n, prev: 0n, start: 0 }, W, 5000).spent).toBe(0n);
    expect(slideEstimate({ cur: 5n, prev: 1n, start: 1000 }, 0, 5000).spent).toBe(5n);
  });
});
