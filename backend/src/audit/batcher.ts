import type { Pool } from 'pg';
import { canonicalJson } from '../crypto/canonical.js';
import { eciesEncrypt } from '../crypto/ecies.js';
import type { TraceRecord } from '../types.js';

export interface StorageUploader {
  upload(data: Buffer): Promise<{ root: string; txHash: string }>;
}

export interface AuditBatcherDeps {
  pool: Pool;
  uploader: StorageUploader;
}

export interface AuditBatcherOptions {
  maxRecords?: number; // flush at N records (spec: 50)
  maxAgeMs?: number; // ... or T elapsed (spec: 60s)
  tickMs?: number;
  retryBackoffMs?: number;
  maxBatchSize?: number;
}

/**
 * Async audit writer (spec §3b): records are already durable in Postgres —
 * this batches them to 0G Storage without ever blocking the hot path.
 * Flush = hash-chained JSONL → ECIES-encrypt to the agent's audit pubkey
 * (owner-held privkey; LEASH stores/ships ONLY ciphertext) → upload →
 * record (batchId, merkleRoot, seqRange, storageTx). Failures leave the
 * cursor untouched and are retried with backoff on later ticks.
 */
export class AuditBatcher {
  private readonly opts: Required<AuditBatcherOptions>;
  private timer: NodeJS.Timeout | null = null;
  private readonly failures = new Map<string, { count: number; nextAttempt: number }>();
  private flushing = false;

  constructor(
    private readonly deps: AuditBatcherDeps,
    options: AuditBatcherOptions = {},
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
      void this.flushOnce().catch((err: unknown) => console.error('audit batcher tick failed', err));
    }, this.opts.tickMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One flush pass over all agents with pending records (also used by tests). */
  async flushOnce(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const pending = await this.deps.pool.query<{ agent_id: string; n: string; oldest: Date }>(
        `SELECT t.agent_id, count(*) AS n, min(t.created_at) AS oldest
         FROM trace_records t
         LEFT JOIN audit_cursor c ON c.agent_id = t.agent_id
         WHERE t.seq > COALESCE(c.last_batched_seq, -1)
         GROUP BY t.agent_id`,
      );
      const now = Date.now();
      for (const row of pending.rows) {
        const due = Number(row.n) >= this.opts.maxRecords || now - row.oldest.getTime() >= this.opts.maxAgeMs;
        if (!due) continue;
        const backoff = this.failures.get(row.agent_id);
        if (backoff && now < backoff.nextAttempt) continue;
        try {
          await this.flushAgent(row.agent_id);
          this.failures.delete(row.agent_id);
        } catch (err) {
          const count = (backoff?.count ?? 0) + 1;
          this.failures.set(row.agent_id, {
            count,
            nextAttempt: now + this.opts.retryBackoffMs * 2 ** Math.min(count - 1, 6),
          });
          console.error(`audit flush failed for agent ${row.agent_id} (attempt ${count})`, err);
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private async flushAgent(agentId: string): Promise<void> {
    const pool = this.deps.pool;
    const agent = await pool.query<{ audit_pubkey: string }>(`SELECT audit_pubkey FROM agents WHERE id = $1`, [
      agentId,
    ]);
    const pubkey = agent.rows[0]?.audit_pubkey;
    if (!pubkey) throw new Error(`agent ${agentId} not found for audit flush`);

    const cursorRes = await pool.query<{ last_batched_seq: string }>(
      `SELECT last_batched_seq FROM audit_cursor WHERE agent_id = $1`,
      [agentId],
    );
    const cursor = cursorRes.rows[0] ? Number(cursorRes.rows[0].last_batched_seq) : -1;
    const records = await pool.query<{ record: TraceRecord }>(
      `SELECT record FROM trace_records WHERE agent_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
      [agentId, cursor, this.opts.maxBatchSize],
    );
    if (records.rows.length === 0) return;

    const list = records.rows.map((r) => r.record);
    const first = list[0];
    const last = list[list.length - 1];
    if (!first || !last) return;

    const jsonl = list.map((r) => canonicalJson(r)).join('\n') + '\n';
    const ciphertext = eciesEncrypt(pubkey, Buffer.from(jsonl, 'utf8'));
    const { root, txHash } = await this.deps.uploader.upload(ciphertext);

    // Success path: record the batch + advance the cursor atomically.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO audit_batches (agent_id, seq_from, seq_to, merkle_root, storage_tx)
         VALUES ($1,$2,$3,$4,$5)`,
        [agentId, first.seq, last.seq, root, txHash],
      );
      await client.query(
        `INSERT INTO audit_cursor (agent_id, last_batched_seq) VALUES ($1, $2)
         ON CONFLICT (agent_id) DO UPDATE SET last_batched_seq = $2`,
        [agentId, last.seq],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
