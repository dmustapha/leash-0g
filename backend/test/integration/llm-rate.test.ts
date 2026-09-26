import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/db.js';
import { createPool } from '../../src/db/pool.js';
import { checkGlobalLlmRate } from '../../src/store/llm-rate.js';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

describe('checkGlobalLlmRate (H-01 durable global cap)', () => {
  it('allows up to the cap, then rejects — address-agnostic', async () => {
    const cap = 3;
    expect(await checkGlobalLlmRate(db.pool, cap)).toBe(true); // 1
    expect(await checkGlobalLlmRate(db.pool, cap)).toBe(true); // 2
    expect(await checkGlobalLlmRate(db.pool, cap)).toBe(true); // 3
    // 4th is over the cap regardless of owner (there is no owner param — global).
    expect(await checkGlobalLlmRate(db.pool, cap)).toBe(false);
    // a rejected call records nothing, so raising the cap admits exactly one more.
    expect(await checkGlobalLlmRate(db.pool, cap + 1)).toBe(true);
  });

  it('is DURABLE across a fresh connection pool (survives a "restart")', async () => {
    const url = process.env['DATABASE_URL'] as string;
    const pool2 = createPool(url, db.schema);
    try {
      // The prior test already recorded rows in this schema; a brand-new pool
      // (simulating a process restart) still sees them → the cap is not reset.
      const before = await pool2.query<{ n: string }>(`SELECT count(*)::text AS n FROM llm_call_log`);
      expect(Number(before.rows[0]?.n)).toBeGreaterThan(0);
      // With a cap below the existing count, a fresh pool rejects immediately.
      expect(await checkGlobalLlmRate(pool2, 1)).toBe(false);
    } finally {
      await pool2.end();
    }
  });
});
