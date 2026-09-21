import type { Pool } from 'pg';

/**
 * P3C-1: the per-owner in-flight create guard. The quota/rate check and the
 * reservation insert run in ONE transaction under a per-owner
 * pg_advisory_xact_lock (the trace-append pattern) — without the lock, two
 * READ-COMMITTED transactions can both count N−1 and both reserve, which
 * re-creates the exact TOCTOU the reservation exists to fix (spec §2a P1).
 *
 * Counting rules:
 * - quota = committed agents rows (ALL, incl. revoked — C-1 semantics
 *   unchanged) + LIVE unexpired reservations.
 * - rate  = agents created in the trailing hour + LIVE unexpired reservations
 *   (a reservation either becomes an agent row, keeping the count, or is
 *   released on failure, freeing it — failure never burns rate).
 * - a reservation past RESERVATION_TTL_MS counts as dead even before the
 *   sweep releases it (the WHERE clause is the source of truth; the sweep is
 *   bookkeeping) — a crashed create can never wedge its owner's quota.
 */

export type ReserveCreateResult =
  | { ok: true; reservationId: string }
  | { ok: false; reason: 'quota_exceeded' }
  | { ok: false; reason: 'rate_limited'; retryAfter: number };

export interface ReserveCreateBounds {
  quotaPerOwner: number;
  ratePerHour: number;
  reservationTtlMs: number;
}

export async function reserveCreate(
  pool: Pool,
  ownerAddr: string,
  bounds: ReserveCreateBounds,
): Promise<ReserveCreateResult> {
  const owner = ownerAddr.toLowerCase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 42))', [`create:${owner}`]);
    const counts = await client.query<{ owned: string; live: string }>(
      `SELECT
         (SELECT count(*) FROM agents WHERE owner_addr = $1) AS owned,
         (SELECT count(*) FROM create_reservations
           WHERE owner_addr = $1 AND released_at IS NULL
             AND created_at > now() - make_interval(secs => $2 / 1000.0)) AS live`,
      [owner, bounds.reservationTtlMs],
    );
    const owned = Number(counts.rows[0]?.owned ?? 0);
    const live = Number(counts.rows[0]?.live ?? 0);
    if (owned + live >= bounds.quotaPerOwner) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'quota_exceeded' };
    }
    // Rate window: recent agents + live reservations (each live reservation is
    // an in-flight create started within the TTL ≪ 1h, so it is in-window by
    // construction). Timestamps feed the Retry-After hint.
    const recent = await client.query<{ created_at: Date }>(
      `SELECT created_at FROM agents
         WHERE owner_addr = $1 AND created_at > now() - interval '1 hour'
       UNION ALL
       SELECT created_at FROM create_reservations
         WHERE owner_addr = $1 AND released_at IS NULL
           AND created_at > now() - make_interval(secs => $2 / 1000.0)
       ORDER BY created_at ASC`,
      [owner, bounds.reservationTtlMs],
    );
    if (recent.rowCount !== null && recent.rowCount >= bounds.ratePerHour) {
      await client.query('ROLLBACK');
      const oldest = recent.rows[0];
      const agesOutMs = oldest ? oldest.created_at.getTime() + 3_600_000 - Date.now() : 3_600_000;
      return { ok: false, reason: 'rate_limited', retryAfter: Math.max(1, Math.ceil(agesOutMs / 1000)) };
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO create_reservations (owner_addr) VALUES ($1) RETURNING id`,
      [owner],
    );
    await client.query('COMMIT');
    const row = inserted.rows[0];
    if (!row) throw new Error('reservation insert failed');
    return { ok: true, reservationId: row.id };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Idempotent release — completion AND failure paths both call this. */
export async function releaseReservation(pool: Pool, id: string): Promise<void> {
  await pool.query(`UPDATE create_reservations SET released_at = now() WHERE id = $1 AND released_at IS NULL`, [id]);
}

/**
 * TTL sweep (boot + timer): release reservations whose create evidently died.
 * Counting already ignores them past the TTL — this is bookkeeping, not the
 * enforcement point.
 */
export async function sweepStaleReservations(pool: Pool, reservationTtlMs: number): Promise<number> {
  const res = await pool.query(
    `UPDATE create_reservations SET released_at = now()
     WHERE released_at IS NULL AND created_at <= now() - make_interval(secs => $1 / 1000.0)`,
    [reservationTtlMs],
  );
  return res.rowCount ?? 0;
}
