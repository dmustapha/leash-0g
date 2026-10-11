import type { Pool } from 'pg';
import { canonicalJson, type Json } from '../crypto/canonical.js';
import { eciesEncrypt, isValidEciesPubkey } from '../crypto/ecies.js';

/**
 * F-3: a stored audit pubkey that is REGEX-shaped but not a secp256k1 point
 * can never encrypt — retrying it forever only burns ticks and spams logs.
 * Typed so the flush loop can tell a permanent key defect from a transient
 * upload/RPC failure (which keeps its retry/backoff semantics).
 */
export class BadAuditKeyError extends Error {
  constructor(key: string) {
    super(`stored audit pubkey for ${key} is not a valid secp256k1 point`);
    this.name = 'BadAuditKeyError';
  }
}

export interface StorageUploader {
  upload(data: Buffer): Promise<{ root: string; txHash: string }>;
}

export interface BatcherDeps {
  pool: Pool;
  uploader: StorageUploader;
}

export interface BatcherOptions {
  maxRecords?: number; // flush at N records (spec: 50)
  maxAgeMs?: number; // ... or T elapsed (spec: 60s)
  tickMs?: number;
  retryBackoffMs?: number;
  maxBatchSize?: number;
}

/**
 * A hash-chained stream the batcher can flush (spec §3d: the SAME machinery
 * serves trace_records per agent and owner_records per owner — one
 * implementation, two sources). `pubkeyFor` returning null means DEFER: the
 * owner stream appends from seq 0 before its key exists; the batcher simply
 * waits and then drains the full backlog once the pubkey is set (S10 — no
 * unlogged gap).
 */
export interface StreamSource {
  name: string;
  /** Keys with unbatched records: (key, pending count, oldest created_at). */
  pending(pool: Pool): Promise<Array<{ key: string; n: number; oldest: Date }>>;
  /** ECIES pubkey for the key's records; null = defer this key (no key yet). */
  pubkeyFor(pool: Pool, key: string): Promise<string | null>;
  cursor(pool: Pool, key: string): Promise<number>;
  records(pool: Pool, key: string, afterSeq: number, limit: number): Promise<Array<{ seq: number; record: Json }>>;
  /** Record the batch + advance the cursor atomically. */
  commit(pool: Pool, key: string, seqFrom: number, seqTo: number, root: string, txHash: string): Promise<void>;
}

export const traceStreamSource: StreamSource = {
  name: 'trace',
  async pending(pool) {
    const res = await pool.query<{ agent_id: string; n: string; oldest: Date }>(
      `SELECT t.agent_id, count(*) AS n, min(t.created_at) AS oldest
       FROM trace_records t
       LEFT JOIN audit_cursor c ON c.agent_id = t.agent_id
       WHERE t.seq > COALESCE(c.last_batched_seq, -1)
       GROUP BY t.agent_id`,
    );
    return res.rows.map((r) => ({ key: r.agent_id, n: Number(r.n), oldest: r.oldest }));
  },
  async pubkeyFor(pool, key) {
    const res = await pool.query<{ audit_pubkey: string }>(`SELECT audit_pubkey FROM agents WHERE id = $1`, [key]);
    const pubkey = res.rows[0]?.audit_pubkey;
    if (!pubkey) throw new Error(`agent ${key} not found for audit flush`);
    return pubkey;
  },
  async cursor(pool, key) {
    const res = await pool.query<{ last_batched_seq: string }>(
      `SELECT last_batched_seq FROM audit_cursor WHERE agent_id = $1`,
      [key],
    );
    return res.rows[0] ? Number(res.rows[0].last_batched_seq) : -1;
  },
  async records(pool, key, afterSeq, limit) {
    const res = await pool.query<{ seq: string; record: Json }>(
      `SELECT seq, record FROM trace_records WHERE agent_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
      [key, afterSeq, limit],
    );
    return res.rows.map((r) => ({ seq: Number(r.seq), record: r.record }));
  },
  async commit(pool, key, seqFrom, seqTo, root, txHash) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO audit_batches (agent_id, seq_from, seq_to, merkle_root, storage_tx)
         VALUES ($1,$2,$3,$4,$5)`,
        [key, seqFrom, seqTo, root, txHash],
      );
      await client.query(
        `INSERT INTO audit_cursor (agent_id, last_batched_seq) VALUES ($1, $2)
         ON CONFLICT (agent_id) DO UPDATE SET last_batched_seq = $2`,
        [key, seqTo],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
};

export const ownerStreamSource: StreamSource = {
  name: 'owner',
  async pending(pool) {
    const res = await pool.query<{ owner_addr: string; n: string; oldest: Date }>(
      `SELECT o.owner_addr, count(*) AS n, min(o.created_at) AS oldest
       FROM owner_records o
       LEFT JOIN owner_audit_cursor c ON c.owner_addr = o.owner_addr
       WHERE o.seq > COALESCE(c.last_batched_seq, -1)
       GROUP BY o.owner_addr`,
    );
    return res.rows.map((r) => ({ key: r.owner_addr, n: Number(r.n), oldest: r.oldest }));
  },
  async pubkeyFor(pool, key) {
    // S10: null = the owner has not set the stream key yet → DEFER (records
    // keep accumulating hash-chained in Postgres; drained in full later).
    const res = await pool.query<{ stream_pubkey: string | null }>(
      `SELECT stream_pubkey FROM owner_settings WHERE owner_addr = $1`,
      [key],
    );
    return res.rows[0]?.stream_pubkey ?? null;
  },
  async cursor(pool, key) {
    const res = await pool.query<{ last_batched_seq: string }>(
      `SELECT last_batched_seq FROM owner_audit_cursor WHERE owner_addr = $1`,
      [key],
    );
    return res.rows[0] ? Number(res.rows[0].last_batched_seq) : -1;
  },
  async records(pool, key, afterSeq, limit) {
    const res = await pool.query<{ seq: string; record: Json }>(
      `SELECT seq, record FROM owner_records WHERE owner_addr = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
      [key, afterSeq, limit],
    );
    return res.rows.map((r) => ({ seq: Number(r.seq), record: r.record }));
  },
  async commit(pool, key, seqFrom, seqTo, root, txHash) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO owner_audit_batches (owner_addr, seq_from, seq_to, merkle_root, storage_tx)
         VALUES ($1,$2,$3,$4,$5)`,
        [key, seqFrom, seqTo, root, txHash],
      );
      await client.query(
        `INSERT INTO owner_audit_cursor (owner_addr, last_batched_seq) VALUES ($1, $2)
         ON CONFLICT (owner_addr) DO UPDATE SET last_batched_seq = $2`,
        [key, seqTo],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
};

/**
 * Async audit writer (spec §3b/§3d): records are already durable in Postgres —
 * this batches them to 0G Storage without ever blocking the hot path.
 * Flush = hash-chained JSONL → ECIES-encrypt to the stream's pubkey
 * (owner-held privkey; LEASH stores/ships ONLY ciphertext) → upload →
 * record (batch row, merkleRoot, seqRange, storageTx). Failures leave the
 * cursor untouched and are retried with backoff on later ticks.
 */
export class StreamBatcher {
  private readonly opts: Required<BatcherOptions>;
  private timer: NodeJS.Timeout | null = null;
  private readonly failures = new Map<string, { count: number; nextAttempt: number }>();
  /** F-3: keys with a permanently unusable audit pubkey — skipped, logged once.
   * TODO(F-3 follow-up): no audit-key rotation path exists yet; a quarantined
   * agent needs a DB hotfix until PATCH /agents/:id/audit-pubkey lands. Records
   * stay durable + hash-chained in Postgres meanwhile. */
  private readonly quarantined = new Set<string>();
  private flushing = false;
  // SCOPE-SHUTDOWN-1: the promise of the CURRENTLY-running flush (null when idle),
  // so shutdown can await it before ending the DB pool. Without this, pool.end()
  // races an in-flight flush → "Cannot use a pool after calling end" per owner.
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly deps: BatcherDeps,
    private readonly source: StreamSource,
    options: BatcherOptions = {},
  ) {
    this.opts = {
      maxRecords: options.maxRecords ?? 50,
      maxAgeMs: options.maxAgeMs ?? 60_000,
      tickMs: options.tickMs ?? 5_000,
      retryBackoffMs: options.retryBackoffMs ?? 10_000,
      maxBatchSize: options.maxBatchSize ?? 500,
    };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flushOnce().catch((err: unknown) =>
        console.error(`${this.source.name} batcher tick failed`, err),
      );
    }, this.opts.tickMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * SCOPE-SHUTDOWN-1: await any in-flight flush so a caller can safely end the DB
   * pool. Call stop() first (halts NEW flushes), then drain(), then pool.end().
   */
  async drain(): Promise<void> {
    while (this.inFlight) await this.inFlight.catch(() => undefined);
  }

  /** One flush pass over all keys with pending records (also used by tests). */
  async flushOnce(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    const run = this.runFlush().finally(() => {
      this.flushing = false;
      this.inFlight = null;
    });
    // runFlush() is async — its body suspends at the first await, so assigning
    // inFlight synchronously here (after the call) is safe: the `flushing` guard
    // above means no second flushOnce / drain() can observe the brief null window.
    this.inFlight = run;
    return run;
  }

  private async runFlush(): Promise<void> {
    const pending = await this.source.pending(this.deps.pool);
    const now = Date.now();
    for (const row of pending) {
      const due = row.n >= this.opts.maxRecords || now - row.oldest.getTime() >= this.opts.maxAgeMs;
      if (!due) continue;
      if (this.quarantined.has(row.key)) continue; // F-3: permanent key defect — no retry
      const backoff = this.failures.get(row.key);
      if (backoff && now < backoff.nextAttempt) continue;
      try {
        await this.flushKey(row.key);
        this.failures.delete(row.key);
      } catch (err) {
        if (err instanceof BadAuditKeyError) {
          // F-3: records stay durable + hash-chained in Postgres; only the
          // 0G Storage batch is withheld until the owner rotates the key.
          this.quarantined.add(row.key);
          this.failures.delete(row.key);
          console.error(`${this.source.name} flush PERMANENTLY skipped for ${row.key}: ${err.message}`);
          continue;
        }
        const count = (backoff?.count ?? 0) + 1;
        this.failures.set(row.key, {
          count,
          nextAttempt: now + this.opts.retryBackoffMs * 2 ** Math.min(count - 1, 6),
        });
        console.error(`${this.source.name} flush failed for ${row.key} (attempt ${count})`, err);
      }
    }
  }

  private async flushKey(key: string): Promise<void> {
    const pool = this.deps.pool;
    const pubkey = await this.source.pubkeyFor(pool, key);
    if (pubkey === null) return; // defer (S10 pre-key window) — not a failure
    if (!isValidEciesPubkey(pubkey)) throw new BadAuditKeyError(key);

    const cursor = await this.source.cursor(pool, key);
    const records = await this.source.records(pool, key, cursor, this.opts.maxBatchSize);
    if (records.length === 0) return;

    const first = records[0];
    const last = records[records.length - 1];
    if (!first || !last) return;

    const jsonl = records.map((r) => canonicalJson(r.record)).join('\n') + '\n';
    const ciphertext = eciesEncrypt(pubkey, Buffer.from(jsonl, 'utf8'));
    const { root, txHash } = await this.deps.uploader.upload(ciphertext);
    await this.source.commit(pool, key, first.seq, last.seq, root, txHash);
  }
}

/** Back-compat name: the Phase-1/2 trace-stream batcher. */
export class AuditBatcher extends StreamBatcher {
  constructor(deps: BatcherDeps, options: BatcherOptions = {}) {
    super(deps, traceStreamSource, options);
  }
}

export type { BatcherDeps as AuditBatcherDeps, BatcherOptions as AuditBatcherOptions };
