import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../../src/db/pool.js';

// Regression for the Stage-E deploy blocker: migrations 020 + 024 backfill
// trace_records.chain_id with an UPDATE, but trace_records carries a BEFORE
// UPDATE ... FOR EACH ROW append-only trigger (001). On a POPULATED table the
// UPDATE raises 'trace_records is append-only' → fatal startup. The standard
// test harness never caught it because it runs every migration on an EMPTY
// schema (0 rows match the backfill, so the per-row trigger never fires).
//
// This test reproduces prod: it applies 001..019, inserts a trace row (the
// append-only trigger permits INSERT), THEN applies 020..024 and asserts the
// owner-run DISABLE/ENABLE-trigger backfill succeeds AND restores the guard.

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

async function runFiles(pool: Pool, files: string[]): Promise<void> {
  const client = await pool.connect();
  try {
    for (const file of files) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    client.release();
  }
}

describe('migration 020/024 — trace_records chain_id backfill on a POPULATED table', () => {
  const url = process.env['DATABASE_URL'];
  const schema = `test_${randomBytes(6).toString('hex')}`;
  let pool: Pool;
  let allFiles: string[];

  beforeAll(async () => {
    if (!url) throw new Error('DATABASE_URL required');
    const admin = createPool(url);
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.end();
    pool = createPool(url, schema);
    allFiles = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (url) {
      const cleanup = createPool(url);
      await cleanup.query(`DROP SCHEMA ${schema} CASCADE`);
      await cleanup.end();
    }
  });

  it('backfills a pre-existing trace row without tripping append-only, and re-enables the guard', async () => {
    const upTo019 = allFiles.filter((f) => f.localeCompare('020_') < 0);
    const from020 = allFiles.filter((f) => f.localeCompare('020_') >= 0);
    expect(upTo019.some((f) => f.startsWith('019_'))).toBe(true);
    expect(from020.some((f) => f.startsWith('020_'))).toBe(true);
    expect(from020.some((f) => f.startsWith('024_'))).toBe(true);

    // Phase 1: schema state as prod was (through 019, no chain_id column yet).
    await runFiles(pool, upTo019);

    // Seed an agent (pre-020 agents has no chain_id column) + a trace row. INSERT
    // is permitted by the append-only trigger; this is the row prod already had.
    const agent = await pool.query<{ id: string }>(
      `INSERT INTO agents (owner_addr, account_addr, session_key_addr, session_key_enc,
                           audit_pubkey, token_id, token_hash, name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        '0x' + 'a1'.repeat(20),
        '0x' + randomBytes(20).toString('hex'),
        '0x' + 'c3'.repeat(20),
        'enc',
        '02' + 'd4'.repeat(32),
        randomBytes(8).toString('hex'),
        'unset',
        'trace-backfill-agent',
      ],
    );
    const agentId = agent.rows[0]!.id;
    await pool.query(
      `INSERT INTO trace_records (agent_id, seq, prev_hash, hash, ts, kind, record)
       VALUES ($1, 0, 'genesis', 'h0', now(), 'inference', '{}'::jsonb)`,
      [agentId],
    );

    // Phase 2: the previously-failing migrations. Pre-fix this throws
    // 'trace_records is append-only'; with the owner-run trigger bypass it succeeds.
    await expect(runFiles(pool, from020)).resolves.toBeUndefined();

    // The historic row was backfilled from its agent's chain_id (default 0G 16602).
    const backfilled = await pool.query<{ chain_id: string }>(
      `SELECT chain_id FROM trace_records WHERE agent_id = $1 AND seq = 0`,
      [agentId],
    );
    expect(Number(backfilled.rows[0]!.chain_id)).toBe(16602);

    // The append-only guard must be ENABLED again — a direct UPDATE still fails.
    await expect(
      pool.query(`UPDATE trace_records SET kind = 'tampered' WHERE agent_id = $1`, [agentId]),
    ).rejects.toThrow(/append-only/);
  });
});
