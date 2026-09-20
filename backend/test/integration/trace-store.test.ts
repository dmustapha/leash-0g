import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { appendTrace, listTraces, verifyAgentChain } from '../../src/trace/trace-store.js';
import { GENESIS_HASH } from '../../src/crypto/hashchain.js';

let db: TestDb;
let agentId: string;

beforeAll(async () => {
  db = await createTestDb();
  agentId = await seedAgent(db.pool);
});

afterAll(async () => {
  await db.drop();
});

describe('trace store', () => {
  it('appends the first record at seq 0 from genesis', async () => {
    const rec = await appendTrace(db.pool, { agentId, kind: 'inference', detail: { note: 'first' } });
    expect(rec.seq).toBe(0);
    expect(rec.prevHash).toBe(GENESIS_HASH);
    expect(rec.hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('chains subsequent records and survives concurrent appends without gaps', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => appendTrace(db.pool, { agentId, kind: 'decision', detail: { i } })),
    );
    const records = await listTraces(db.pool, agentId, { limit: 100 });
    expect(records.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const verdict = await verifyAgentChain(db.pool, agentId);
    expect(verdict.ok).toBe(true);
  });

  it('keeps per-agent chains independent', async () => {
    const other = await seedAgent(db.pool);
    const rec = await appendTrace(db.pool, { agentId: other, kind: 'inference' });
    expect(rec.seq).toBe(0);
    expect((await verifyAgentChain(db.pool, other)).ok).toBe(true);
  });

  it('records original AND effective request on modify', async () => {
    const rec = await appendTrace(db.pool, {
      agentId,
      kind: 'modify',
      originalRequest: { messages: [{ role: 'user', content: 'send it all' }] },
      effectiveRequest: { messages: [{ role: 'user', content: 'send within policy' }] },
    });
    const back = await listTraces(db.pool, agentId, { afterSeq: rec.seq - 1, limit: 1 });
    expect(back[0]?.originalRequest).toEqual({ messages: [{ role: 'user', content: 'send it all' }] });
    expect(back[0]?.effectiveRequest).toEqual({ messages: [{ role: 'user', content: 'send within policy' }] });
  });

  it('rejects UPDATE and DELETE (append-only trigger)', async () => {
    await expect(db.pool.query('UPDATE trace_records SET kind = $1 WHERE agent_id = $2', ['x', agentId])).rejects.toThrow(
      /append-only/,
    );
    await expect(db.pool.query('DELETE FROM trace_records WHERE agent_id = $1', [agentId])).rejects.toThrow(/append-only/);
  });

  it('rejects a forged seq gap on insert (unique + chain verify)', async () => {
    // direct insert with a gap: chain verification must flag it
    const forged = {
      agentId,
      seq: 999,
      prevHash: '0x' + '00'.repeat(32),
      hash: '0x' + 'ff'.repeat(32),
      ts: new Date().toISOString(),
      kind: 'inference',
    };
    await db.pool.query(
      `INSERT INTO trace_records (agent_id, seq, prev_hash, hash, ts, kind, record)
       VALUES ($1, 999, $2, $3, now(), 'inference', $4)`,
      [agentId, forged.prevHash, forged.hash, JSON.stringify(forged)],
    );
    const verdict = await verifyAgentChain(db.pool, agentId);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.badSeq).toBe(999);
  });

  it('duplicate seq insert violates the unique constraint', async () => {
    await expect(
      db.pool.query(
        `INSERT INTO trace_records (agent_id, seq, prev_hash, hash, ts, kind, record)
         VALUES ($1, 0, $2, $3, now(), 'inference', '{}')`,
        [agentId, GENESIS_HASH, '0x' + 'aa'.repeat(32)],
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it('pages traces by cursor', async () => {
    const page1 = await listTraces(db.pool, agentId, { limit: 3 });
    expect(page1).toHaveLength(3);
    const last = page1[2];
    if (!last) throw new Error('missing');
    const page2 = await listTraces(db.pool, agentId, { afterSeq: last.seq, limit: 3 });
    expect(page2[0]?.seq).toBe(last.seq + 1);
  });
});

describe('incremental chain verification (L-04)', () => {
  it('verifies incrementally from a cached head and detects a forged new record', async () => {
    const { verifyAgentChainIncremental, _clearVerifyCache } = await import('../../src/trace/trace-store.js');
    _clearVerifyCache();
    const freshAgent = await seedAgent(db.pool, { accountAddr: '0x2222222222222222222222222222222222222222' });
    for (let i = 0; i < 3; i++) {
      await appendTrace(db.pool, { agentId: freshAgent, kind: 'inference', detail: { i } });
    }
    // first call: full scan, ok, caches head seq 2
    expect((await verifyAgentChainIncremental(db.pool, freshAgent)).ok).toBe(true);

    // append 2 more, verify again — only new records scanned (behavioral: still ok)
    await appendTrace(db.pool, { agentId: freshAgent, kind: 'action', detail: { i: 3 } });
    await appendTrace(db.pool, { agentId: freshAgent, kind: 'action', detail: { i: 4 } });
    expect((await verifyAgentChainIncremental(db.pool, freshAgent)).ok).toBe(true);

    // forge a NEW record with a broken prevHash link (INSERT is allowed; UPDATE/DELETE are not)
    await db.pool.query(
      `INSERT INTO trace_records (agent_id, seq, prev_hash, hash, ts, kind, record)
       VALUES ($1::uuid, 5, '0xdead', '0xbeef', now(), 'action',
               jsonb_build_object('agentId',$2::text,'seq',5,'prevHash','0xdead','ts',now()::text,'kind','action','hash','0xbeef'))`,
      [freshAgent, freshAgent],
    );
    const bad = await verifyAgentChainIncremental(db.pool, freshAgent);
    expect(bad.ok).toBe(false);

    // failure drops the cache → next call re-scans from genesis and still reports the break
    const again = await verifyAgentChainIncremental(db.pool, freshAgent);
    expect(again.ok).toBe(false);
  });

  it('incremental result matches full verifyAgentChain on a clean chain', async () => {
    const { verifyAgentChainIncremental } = await import('../../src/trace/trace-store.js');
    const full = await verifyAgentChain(db.pool, agentId);
    const inc = await verifyAgentChainIncremental(db.pool, agentId);
    expect(inc.ok).toBe(full.ok);
  });
});
