import { describe, it, expect } from 'vitest';
import { budgetExhausted, nextCycleDelayMs, DEFAULT_MAX_BACKOFF_MS } from '../../src/runtime/failure-budget.js';

describe('E1 failure budget arithmetic', () => {
  it('trips exactly at the budget; 0 disables', () => {
    expect(budgetExhausted(4, 5)).toBe(false);
    expect(budgetExhausted(5, 5)).toBe(true);
    expect(budgetExhausted(99, 0)).toBe(false);
  });

  it('keeps the normal cadence when healthy, then doubles per failure up to the cap', () => {
    const base = 30_000;
    expect(nextCycleDelayMs(base, 0, DEFAULT_MAX_BACKOFF_MS)).toBe(base);
    expect(nextCycleDelayMs(base, 1, DEFAULT_MAX_BACKOFF_MS)).toBe(30_000);
    expect(nextCycleDelayMs(base, 2, DEFAULT_MAX_BACKOFF_MS)).toBe(60_000);
    expect(nextCycleDelayMs(base, 3, DEFAULT_MAX_BACKOFF_MS)).toBe(120_000);
    expect(nextCycleDelayMs(base, 10, DEFAULT_MAX_BACKOFF_MS)).toBe(DEFAULT_MAX_BACKOFF_MS);
    expect(nextCycleDelayMs(base, 1000, DEFAULT_MAX_BACKOFF_MS)).toBe(DEFAULT_MAX_BACKOFF_MS);
  });

  it('never delays below the base interval, even if the cap is configured under it', () => {
    expect(nextCycleDelayMs(30_000, 5, 1_000)).toBe(30_000);
  });
});
