import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/db.js';
import { classifyCycleResult, classifyThrown, recordCycleResult, resetBreakers, FAILURE_THRESHOLDS } from '../../src/runtime/typed-breakers.js';

const PARSE_MISS = 'model output was not a valid decision';
let db: TestDb;
beforeAll(async () => { db = await createTestDb(); });
afterAll(async () => { await db.drop(); });
beforeEach(async () => { await db.pool.query('TRUNCATE agent_breakers'); });

const rec = (cls: Parameters<typeof recordCycleResult>[2], a = 'a1') => recordCycleResult(db.pool, a, cls, 'detail');

describe('typed, persisted failure budget', () => {
  it('permanent (wall refusal) trips fast: on the 2nd', async () => {
    expect((await rec('permanent')).tripped).toBeNull();
    const r = await rec('permanent');
    expect(r.tripped).toBe('permanent');
    expect(r.count).toBe(FAILURE_THRESHOLDS.permanent);
  });

  it('transient trips slow (5th) and a healthy cycle resets the consecutive count', async () => {
    for (let i = 0; i < 3; i++) await rec('transient');
    await rec(null); // healthy
    for (let i = 0; i < 4; i++) expect((await rec('transient')).tripped).toBeNull();
    expect((await rec('transient')).tripped).toBe('transient');
  });

  it('model failures trip on the 3rd; ambiguous trips at once', async () => {
    await rec('model'); await rec('model');
    expect((await rec('model')).tripped).toBe('model');
    expect((await rec('ambiguous', 'a2')).tripped).toBe('ambiguous');
  });

  it('classes are independent: transient noise never trips a permanent budget', async () => {
    for (let i = 0; i < 4; i++) await rec('transient');
    expect((await rec('permanent')).tripped).toBeNull();
  });

  it('counts live in the database, so a restart cannot reset them', async () => {
    await rec('permanent');
    const row = (await db.pool.query(`SELECT count FROM agent_breakers WHERE agent_id='a1' AND class='permanent'`)).rows[0];
    expect(row.count).toBe(1);
    expect((await rec('permanent')).tripped).toBe('permanent'); // a "new process" continues from the stored count
  });

  it('permanent refusals more than a day apart are not a loop (decay)', async () => {
    await rec('permanent');
    await db.pool.query(`UPDATE agent_breakers SET last_at = now() - interval '25 hours' WHERE agent_id='a1'`);
    const r = await rec('permanent');
    expect(r.tripped).toBeNull();
    expect(r.count).toBe(1);
  });

  it('resetBreakers gives an owner-resumed agent a fresh budget', async () => {
    await rec('permanent'); await rec('permanent');
    await resetBreakers(db.pool, 'a1');
    expect((await rec('permanent')).tripped).toBeNull();
  });

  it('classifies cycle results', () => {
    expect(classifyCycleResult({ outcome: { type: 'failed', reason: 'x', decoded: { errorName: 'OverPerTransferCap' } }, parseMissReason: PARSE_MISS })).toBe('permanent');
    expect(classifyCycleResult({ outcome: { type: 'failed', reason: 'rpc exploded' }, parseMissReason: PARSE_MISS })).toBe('transient');
    expect(classifyCycleResult({ outcome: { type: 'stood_down', reason: PARSE_MISS }, parseMissReason: PARSE_MISS })).toBe('model');
    expect(classifyCycleResult({ outcome: { type: 'stood_down', reason: 'x' }, finishReason: 'length', parseMissReason: PARSE_MISS })).toBe('model');
    expect(classifyCycleResult({ outcome: { type: 'stood_down', reason: 'target balance already met — nothing to do' }, parseMissReason: PARSE_MISS })).toBeNull();
    expect(classifyCycleResult({ outcome: { type: 'acted' }, parseMissReason: PARSE_MISS })).toBeNull();
    expect(classifyThrown(new Error('gateway refused inference: status 502'))).toBe('model');
    expect(classifyThrown(new Error('rpc exploded'))).toBe('transient');
  });
});
