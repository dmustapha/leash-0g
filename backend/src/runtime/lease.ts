import type { Pool, PoolClient } from 'pg';

/**
 * F-6: the backend assumes it is the ONLY runtime looping agents against this
 * database. A branch deploy and a stray local backend sharing one Neon DB
 * both ran runtimes concurrently (environment incident, 2026-10-04) — two
 * managers ticking the same agents. This lease makes the single-instance
 * assumption EXPLICIT at the DB layer: a session-scoped advisory lock held on
 * a dedicated connection for the life of the process. Only the holder runs
 * agent loops + runtime-adjacent tickers; a second backend keeps its API up
 * but defers, retrying until the holder dies.
 *
 * Fail-safe direction: a session advisory lock dies WITH its connection — if
 * our lease connection drops, Postgres frees the lock and another instance
 * may legitimately take over, so continuing to loop here would double-run.
 * The onLost callback (production: log + process.exit so the supervisor
 * restarts us into the retry path) is therefore mandatory wiring.
 */
const LEASE_KEY = 'leash:runtime-lease';

export class RuntimeLease {
  private client: PoolClient | null = null;
  private acquired = false;
  private stopped = false;

  constructor(
    private readonly pool: Pool,
    private readonly onLost: (err: unknown) => void,
    private readonly retryMs = 15_000,
  ) {}

  held(): boolean {
    return this.acquired;
  }

  /** Resolves once the lease is held — polls pg_try_advisory_lock until then. */
  async acquire(): Promise<void> {
    for (;;) {
      if (this.stopped) throw new Error('runtime lease acquisition stopped');
      try {
        if (await this.tryAcquire()) return;
        console.error(
          `runtime lease held by another backend instance sharing this DB — agent loops deferred here; retrying in ${this.retryMs}ms`,
        );
      } catch (err) {
        // A transient connect/query failure (Neon cold start, pool pressure)
        // must not park this instance as a permanent non-holder — retry.
        console.error('runtime lease: tryAcquire error, will retry', err);
      }
      // The sleep is unref'd — a graceful shutdown with no other open handles
      // exits immediately; otherwise it delays the stopped-check by ≤retryMs.
      await new Promise((r) => setTimeout(r, this.retryMs).unref());
    }
  }

  /** One attempt (also driven directly by tests). True = held. */
  async tryAcquire(): Promise<boolean> {
    if (this.acquired) return true;
    const client = await this.pool.connect();
    try {
      const res = await client.query<{ ok: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 42)) AS ok',
        [LEASE_KEY],
      );
      if (res.rows[0]?.ok === true) {
        this.client = client; // held for the process lifetime — NOT released to the pool
        this.acquired = true;
        client.on('error', (err: unknown) => {
          // Lock died with the connection — another instance may now hold it.
          this.acquired = false;
          this.onLost(err);
        });
        return true;
      }
      client.release();
      return false;
    } catch (err) {
      client.release();
      throw err;
    }
  }

  /** Graceful shutdown: give the lock back so the next boot acquires instantly. */
  release(): void {
    this.stopped = true;
    if (this.client) {
      this.acquired = false;
      this.client.removeAllListeners('error');
      this.client.release();
      this.client = null;
    }
  }
}
