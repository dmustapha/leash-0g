/**
 * AQ-FND beta slice E1 — the loop-breaker's pure arithmetic.
 *
 * A cycle that THROWS counts as a failure; one that returns (including a "stand down" decision)
 * resets the count. After `budget` consecutive failures the runtime pauses the agent; before that
 * each failure delays the next cycle exponentially so a failing agent slows down instead of
 * hammering the gateway/RPC at its normal cadence.
 */

export const DEFAULT_FAILURE_BUDGET = 5;
export const DEFAULT_MAX_BACKOFF_MS = 15 * 60_000;

/** True once `failures` consecutive failures reach a positive budget (0 disables the breaker). */
export function budgetExhausted(failures: number, budget: number): boolean {
  return budget > 0 && failures >= budget;
}

/** Delay before the next cycle: the base interval when healthy, doubling per failure up to the cap. */
export function nextCycleDelayMs(intervalMs: number, failures: number, maxBackoffMs: number): number {
  if (failures <= 0) return intervalMs;
  const exp = Math.min(failures - 1, 30); // clamp the shift: 2^30 * interval already exceeds any sane cap
  return Math.min(intervalMs * 2 ** exp, Math.max(maxBackoffMs, intervalMs));
}
