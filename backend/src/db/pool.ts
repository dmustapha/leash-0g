import pg from 'pg';

/**
 * Postgres pool. `schema` pins search_path per connection — production uses
 * the default (public); tests run in an ephemeral schema for hermeticity.
 *
 * The SET is issued from the pool's `connect` event. Neon's pooler rejects the
 * `options` startup parameter, so we cannot set search_path at startup; the
 * event-based SET is still race-free because pg serializes queries per
 * connection — the SET is queued on the client before any checkout query.
 */
export function createPool(databaseUrl: string, schema?: string, max = 10): pg.Pool {
  if (schema && !/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('invalid schema name');
  // Session-level SET search_path is unreliable through Neon's pgbouncer
  // (transaction pooling can hand each tx a different backend session), so a
  // schema override forces the DIRECT endpoint.
  const connectionString = schema ? databaseUrl.replace('-pooler.', '.') : databaseUrl;
  const pool = new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  });
  if (schema) {
    pool.on('connect', (client) => {
      client.query(`SET search_path TO ${schema}`).catch((err: unknown) => {
        // Surface loudly: a wrong search_path must never fail silent.
        console.error('failed to set search_path', err);
      });
    });
  }
  return pool;
}

/**
 * F-16: a SMALL pool pinned to the DIRECT (unpooled) Neon endpoint, for the
 * runtime lease's session-scoped advisory lock. A session advisory lock — like
 * `SET search_path` above — is unreliable through Neon's pgbouncer: in
 * transaction pooling the lock lands on a pooler server-connection that detaches
 * from the backend, so the lock shows "held" (as a `::1` server conn) while no
 * backend actually loops, and killing the holder just lets another pooled conn
 * take it. Forcing the direct endpoint makes the lock a true session lock tied
 * to THIS process's connection (dies with it — the fail-safe the lease needs).
 */
export function createDirectPool(databaseUrl: string, max = 2): pg.Pool {
  return createPool(databaseUrl.replace('-pooler.', '.'), undefined, max);
}
