import type { Pool } from 'pg';

/**
 * H-01 (round-2 red-team) COMPLETE fix: a DURABLE, address-agnostic global ceiling
 * on the owner-triggered 0G Compute surface (elevate / direct / status), which all
 * run on LEASH's SHARED Compute key. The per-owner in-process limiters are
 * bypassable by rotating fresh wallet addresses; this global cap bounds aggregate
 * cost regardless of address rotation, and — unlike the in-process counter — it
 * survives restarts and holds across horizontally-scaled instances (shared DB).
 *
 * Serialized under a fixed advisory lock so a concurrent burst cannot overshoot
 * the cap. Prunes rows older than the window on each check, so the ledger stays
 * ~1h-bounded. Returns true (and records the call) when under the cap; false
 * (recording nothing) when at/over it.
 */
const GLOBAL_LOCK_KEY = 'llm_global_rate';
const WINDOW = "1 hour";

export async function checkGlobalLlmRate(pool: Pool, perHour: number): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 7))`, [GLOBAL_LOCK_KEY]);
    await client.query(`DELETE FROM llm_call_log WHERE ts < now() - interval '${WINDOW}'`);
    const c = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM llm_call_log`);
    const n = Number(c.rows[0]?.n ?? 0);
    if (n >= perHour) {
      await client.query('COMMIT');
      return false;
    }
    await client.query(`INSERT INTO llm_call_log DEFAULT VALUES`);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
