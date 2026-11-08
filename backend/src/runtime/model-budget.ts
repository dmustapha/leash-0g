import type { Pool } from 'pg';

/**
 * AQ-FND S1 hard budget: a per-agent, per-UTC-day cap on model calls. Enforced BEFORE the call (we refuse the
 * call; an alert is not enforcement). The counter is only bumped when a call is actually about to be made.
 */
export const DEFAULT_MODEL_CALLS_PER_AGENT_PER_DAY = 2000;

export async function reserveModelCall(pool: Pool, agentId: string, cap: number): Promise<{ allowed: boolean; used: number }> {
  if (cap <= 0) return { allowed: true, used: 0 }; // 0 = unlimited (kill switch, mirrors failureBudget=0)
  const { rows } = await pool.query<{ model_calls: number }>(
    `INSERT INTO agent_daily_usage (agent_id, day, model_calls) VALUES ($1, (now() AT TIME ZONE 'utc')::date, 1)
     ON CONFLICT (agent_id, day) DO UPDATE SET model_calls = agent_daily_usage.model_calls + 1
     RETURNING model_calls`,
    [agentId],
  );
  const used = rows[0]?.model_calls ?? 1;
  return { allowed: used <= cap, used };
}
