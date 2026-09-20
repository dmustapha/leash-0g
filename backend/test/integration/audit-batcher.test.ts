import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrivateKey } from 'eciesjs';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { appendTrace } from '../../src/trace/trace-store.js';
import { AuditBatcher, type StorageUploader } from '../../src/audit/batcher.js';
import { eciesDecrypt } from '../../src/crypto/ecies.js';
import { verifyChain, type ChainedRecord } from '../../src/crypto/hashchain.js';

let db: TestDb;

class FakeUploader implements StorageUploader {
  public uploads: Buffer[] = [];
  public failNext = 0;
  private n = 0;

  async upload(data: Buffer): Promise<{ root: string; txHash: string }> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('0G storage unavailable (injected)');
    }
    this.uploads.push(data);
    this.n += 1;
    return { root: `0xroot${this.n}`, txHash: `0xtx${this.n}` };
  }
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

async function seedAgentWithKey(): Promise<{ agentId: string; key: PrivateKey }> {
  const key = new PrivateKey();
  const agentId = await seedAgent(db.pool, { auditPubkey: key.publicKey.toHex() });
  return { agentId, key };
}

describe('audit batcher', () => {
  it('flushes at N records: hash-chained JSONL, ECIES-encrypted, batch row + cursor advance', async () => {
    const { agentId, key } = await seedAgentWithKey();
    const uploader = new FakeUploader();
    const batcher = new AuditBatcher({ pool: db.pool, uploader }, { maxRecords: 3, maxAgeMs: 60_000 });

    await appendTrace(db.pool, { agentId, kind: 'inference', detail: { i: 0 } });
    await appendTrace(db.pool, { agentId, kind: 'decision', detail: { i: 1 } });
    await batcher.flushOnce();
    expect(uploader.uploads).toHaveLength(0); // below N and below age threshold

    await appendTrace(db.pool, { agentId, kind: 'action', detail: { i: 2 } });
    await batcher.flushOnce();
    expect(uploader.uploads).toHaveLength(1);

    // ciphertext is NOT plaintext and decrypts ONLY with the owner audit key
    const ct = uploader.uploads[0];
    if (!ct) throw new Error('missing upload');
    expect(ct.toString('utf8')).not.toContain('inference');
    const jsonl = eciesDecrypt(key.secret, ct).toString('utf8');
    const lines = jsonl.trimEnd().split('\n').map((l) => JSON.parse(l) as ChainedRecord);
    expect(lines).toHaveLength(3);
    expect(verifyChain(lines).ok).toBe(true);

    const batch = await db.pool.query(`SELECT * FROM audit_batches WHERE agent_id = $1`, [agentId]);
    expect(batch.rowCount).toBe(1);
    expect(batch.rows[0].seq_from).toBe('0');
    expect(batch.rows[0].seq_to).toBe('2');
    expect(batch.rows[0].merkle_root).toBe('0xroot1');
    expect(batch.rows[0].storage_tx).toBe('0xtx1');

    const cursor = await db.pool.query(`SELECT last_batched_seq FROM audit_cursor WHERE agent_id = $1`, [agentId]);
    expect(cursor.rows[0].last_batched_seq).toBe('2');
  });

  it('flushes by age even below N', async () => {
    const { agentId } = await seedAgentWithKey();
    const uploader = new FakeUploader();
    const batcher = new AuditBatcher({ pool: db.pool, uploader }, { maxRecords: 50, maxAgeMs: 0 });
    await appendTrace(db.pool, { agentId, kind: 'inference' });
    await batcher.flushOnce();
    expect(uploader.uploads).toHaveLength(1);
  });

  it('retries after upload failure — records are never lost, cursor only moves on success', async () => {
    const { agentId } = await seedAgentWithKey();
    const uploader = new FakeUploader();
    uploader.failNext = 1;
    const batcher = new AuditBatcher(
      { pool: db.pool, uploader },
      { maxRecords: 1, maxAgeMs: 60_000, retryBackoffMs: 0 },
    );
    await appendTrace(db.pool, { agentId, kind: 'inference' });
    await batcher.flushOnce(); // fails (injected)
    expect((await db.pool.query(`SELECT 1 FROM audit_batches WHERE agent_id = $1`, [agentId])).rowCount).toBe(0);
    await batcher.flushOnce(); // retry succeeds
    expect((await db.pool.query(`SELECT 1 FROM audit_batches WHERE agent_id = $1`, [agentId])).rowCount).toBe(1);
  });

  it('subsequent flush picks up only NEW records (seq ranges are contiguous, no overlap)', async () => {
    const { agentId } = await seedAgentWithKey();
    const uploader = new FakeUploader();
    const batcher = new AuditBatcher({ pool: db.pool, uploader }, { maxRecords: 2, maxAgeMs: 60_000 });
    await appendTrace(db.pool, { agentId, kind: 'inference' });
    await appendTrace(db.pool, { agentId, kind: 'inference' });
    await batcher.flushOnce();
    await appendTrace(db.pool, { agentId, kind: 'action' });
    await appendTrace(db.pool, { agentId, kind: 'action' });
    await batcher.flushOnce();
    const rows = await db.pool.query<{ seq_from: string; seq_to: string }>(
      `SELECT seq_from, seq_to FROM audit_batches WHERE agent_id = $1 ORDER BY seq_from`,
      [agentId],
    );
    expect(rows.rows.map((r) => [r.seq_from, r.seq_to])).toEqual([
      ['0', '1'],
      ['2', '3'],
    ]);
  });
});
