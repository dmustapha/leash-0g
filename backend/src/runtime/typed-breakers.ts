import type { Pool } from 'pg';

/**
 * AQ-FND S1 (WP-F): typed, PERSISTED failure budget. Replaces "N consecutive thrown cycles, in memory"
 * as the only guard: an on-chain refusal repeated every 30 s, a model that keeps emitting garbage, or an
 * RPC that is down are DIFFERENT problems with different thresholds, and none may reset on a restart.
 */
export type FailureClass = 'permanent' | 'transient' | 'model' | 'ambiguous';

/** Trips when count >= threshold. Value-moving refusals trip fast; infrastructure noise trips slow. */
export const FAILURE_THRESHOLDS: Record<FailureClass, number> = { permanent: 2, transient: 5, model: 3, ambiguous: 1 };
/** permanent counts decay: two refusals more than a day apart are not a loop. */
const PERMANENT_WINDOW_HOURS = 24;

export interface CycleOutcomeLike {
  type: string;
  reason?: string;
  decoded?: unknown;
}

/**
 * Class of a cycle's result, or null when the cycle was healthy.
 *   failed + decoded wall error      -> permanent      failed + anything else -> transient
 *   unparsable / length / loop       -> model          unknown-tx-state       -> ambiguous
 * `stood_down` for a REASONED refusal or "nothing to do" is healthy by design.
 */
export function classifyCycleResult(input: {
  outcome: CycleOutcomeLike | null | undefined;
  finishReason?: string | null;
  parseMissReason: string;
}): FailureClass | null {
  const o = input.outcome;
  if (!o) return null;
  if (o.type === 'failed') return o.decoded ? 'permanent' : 'transient';
  if (o.type === 'stood_down') {
    if (o.reason === input.parseMissReason) return 'model';
    if (input.finishReason === 'length') return 'model';
    if (o.reason && /transaction counter was used by something LEASH did not send/i.test(o.reason)) return 'ambiguous';
  }
  return null;
}

/** Class of a THROWN cycle (the graph itself blew up). */
export function classifyThrown(err: unknown): FailureClass {
  const msg = err instanceof Error ? err.message : String(err);
  if (/gateway refused inference|unparsable|invalid decision|finish_reason/i.test(msg)) return 'model';
  return 'transient';
}

export interface BreakerResult {
  /** the class that crossed its threshold on THIS record, if any */
  tripped: FailureClass | null;
  count: number;
}

/** Record a cycle result: `cls === null` is a healthy cycle (resets consecutive counters). */
export async function recordCycleResult(pool: Pool, agentId: string, cls: FailureClass | null, detail?: string): Promise<BreakerResult> {
  if (cls === null) {
    await pool.query(`UPDATE agent_breakers SET count = 0 WHERE agent_id = $1 AND class IN ('transient', 'model') AND count > 0`, [agentId]);
    return { tripped: null, count: 0 };
  }
  const { rows } = await pool.query<{ count: number }>(
    `INSERT INTO agent_breakers (agent_id, class, count, first_at, last_at, last_detail)
     VALUES ($1, $2, 1, now(), now(), $3)
     ON CONFLICT (agent_id, class) DO UPDATE SET
       count = CASE WHEN $2 = 'permanent' AND agent_breakers.last_at < now() - make_interval(hours => $4) THEN 1 ELSE agent_breakers.count + 1 END,
       first_at = CASE WHEN $2 = 'permanent' AND agent_breakers.last_at < now() - make_interval(hours => $4) THEN now() ELSE agent_breakers.first_at END,
       last_at = now(),
       last_detail = $3
     RETURNING count`,
    [agentId, cls, (detail ?? '').slice(0, 300), PERMANENT_WINDOW_HOURS],
  );
  const count = rows[0]?.count ?? 1;
  if (count >= FAILURE_THRESHOLDS[cls]) {
    await pool.query(`UPDATE agent_breakers SET tripped_at = now() WHERE agent_id = $1 AND class = $2`, [agentId, cls]);
    return { tripped: cls, count };
  }
  return { tripped: null, count };
}

/** Owner pressed Start/Resume: a fresh budget (the cause was presumably fixed). */
export async function resetBreakers(pool: Pool, agentId: string): Promise<void> {
  await pool.query(`DELETE FROM agent_breakers WHERE agent_id = $1`, [agentId]);
}

/** Plain-language one-liner for the alert/trace when a class trips. */
export function describeTrip(cls: FailureClass, count: number, detail: string): string {
  switch (cls) {
    case 'permanent':
      return `it was refused ${count} times in a row by its own spending limits or the contract (${detail || 'no detail'}); repeating cannot help`;
    case 'transient':
      return `${count} cycles in a row failed on infrastructure (network/RPC/timeouts): ${detail || 'no detail'}`;
    case 'model':
      return `its reasoning model failed ${count} cycles in a row (unreadable, cut off or looping output): ${detail || 'no detail'}`;
    case 'ambiguous':
      return `its transaction counter was used by something LEASH did not send, so it stopped to avoid sending twice`;
  }
}
