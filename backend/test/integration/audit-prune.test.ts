import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { appendTrace, verifyAgentChain, verifyAgentChainIncremental, _clearVerifyCache } from '../../src/trace/trace-store.js';
import {
  appendOwnerRecord,
  verifyOwnerChain,
  verifyOwnerChainIncremental,
  _clearOwnerVerifyCache,
} from '../../src/store/owner-records.js';
import {
  computeCutoffs,
  pruneStream,
  getPruneCheckpoint,
  TRACE_TABLES,
  OWNER_TABLES,
} from '../../src/store/audit-prune.js';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

/** Seed trace records 0..n-1 for a fresh agent. */
async function seedTrace(n: number): Promise<string> {
  const agentId = await seedAgent(db.pool);
  for (let i = 0; i < n; i += 1) {
    await appendTrace(db.pool, { agentId, kind: 'inference', detail: { i } });
  }
  return agentId;
}

/** Mark rows up to lastBatchedSeq as archived to 0G. */
async function setBatched(agentId: string, lastBatchedSeq: number): Promise<void> {
  await db.pool.query(
    `INSERT INTO audit_cursor (agent_id, last_batched_seq) VALUES ($1, $2)
     ON CONFLICT (agent_id) DO UPDATE SET last_batched_seq = EXCLUDED.last_batched_seq`,
    [agentId, lastBatchedSeq],
  );
}

/** Backdate created_at for rows up to maxSeq (admin bypasses the append-only trigger). */
async function ageRows(agentId: string, maxSeq: number, days: number): Promise<void> {
  await db.pool.query('ALTER TABLE trace_records DISABLE TRIGGER trace_records_append_only');
  await db.pool.query(
    `UPDATE trace_records SET created_at = now() - ($3 || ' days')::interval
       WHERE agent_id = $1 AND seq <= $2`,
    [agentId, maxSeq, String(days)],
  );
  await db.pool.query('ALTER TABLE trace_records ENABLE TRIGGER trace_records_append_only');
}

async function countRows(agentId: string): Promise<number> {
  const res = await db.pool.query<{ c: string }>(
    'SELECT count(*)::text AS c FROM trace_records WHERE agent_id = $1',
    [agentId],
  );
  return Number(res.rows[0]?.c);
}

async function prune(agentId: string, retentionDays = 90): Promise<void> {
  const plans = await computeCutoffs(db.pool, TRACE_TABLES, retentionDays);
  const client = await db.pool.connect();
  try {
    for (const plan of plans.filter((p) => p.key === agentId)) {
      await pruneStream(client, TRACE_TABLES, plan);
    }
  } finally {
    client.release();
  }
}

describe('audit prune', () => {
  it('prunes archived+old prefix; verification still ok from the checkpoint', async () => {
    const agentId = await seedTrace(10); // seq 0..9
    await setBatched(agentId, 9); // all archived to 0G
    await ageRows(agentId, 9, 100); // all older than retention

    // pre-prune: full chain verifies from genesis
    expect(await verifyAgentChain(db.pool, agentId)).toEqual({ ok: true });

    const plans = await computeCutoffs(db.pool, TRACE_TABLES, 90);
    const plan = plans.find((p) => p.key === agentId);
    expect(plan).toBeDefined();
    expect(plan?.cutoffSeq).toBe(9);
    expect(plan?.eligibleRows).toBe(10);

    await prune(agentId);

    // rows 0..9 gone
    expect(await countRows(agentId)).toBe(0);

    // checkpoint row exists at the cutoff
    const cp = await getPruneCheckpoint(db.pool, 'trace', agentId);
    expect(cp?.seq).toBe(9);
    expect(cp?.hash).toMatch(/^0x[0-9a-f]{64}$/);

    // append a new record (seq 10) — it links to the pruned chain's head
    await appendTrace(db.pool, { agentId, kind: 'inference', detail: { i: 10 } });
    expect(await countRows(agentId)).toBe(1);

    // verification STILL ok — now anchored at the checkpoint, not genesis
    expect(await verifyAgentChain(db.pool, agentId)).toEqual({ ok: true });
  });

  it('leaves a surviving suffix and verifies it from the checkpoint', async () => {
    const agentId = await seedTrace(10); // seq 0..9
    await setBatched(agentId, 9);
    await ageRows(agentId, 4, 100); // only 0..4 old enough

    const plan = (await computeCutoffs(db.pool, TRACE_TABLES, 90)).find((p) => p.key === agentId);
    expect(plan?.cutoffSeq).toBe(4);

    await prune(agentId);

    // 0..4 gone, 5..9 survive
    expect(await countRows(agentId)).toBe(5);
    const cp = await getPruneCheckpoint(db.pool, 'trace', agentId);
    expect(cp?.seq).toBe(4);
    expect(await verifyAgentChain(db.pool, agentId)).toEqual({ ok: true });
  });

  it('never prunes not-yet-batched rows even if old', async () => {
    const agentId = await seedTrace(10);
    await setBatched(agentId, 4); // only 0..4 archived to 0G
    await ageRows(agentId, 9, 100); // all old

    const plan = (await computeCutoffs(db.pool, TRACE_TABLES, 90)).find((p) => p.key === agentId);
    expect(plan?.cutoffSeq).toBe(4); // capped at last_batched_seq, not seq 9

    await prune(agentId);
    expect(await countRows(agentId)).toBe(5); // 5..9 kept (not batched)
    expect(await verifyAgentChain(db.pool, agentId)).toEqual({ ok: true });
  });

  it('is idempotent — a second prune deletes 0', async () => {
    const agentId = await seedTrace(6);
    await setBatched(agentId, 5);
    await ageRows(agentId, 5, 100);

    await prune(agentId);
    expect(await countRows(agentId)).toBe(0);

    // second run: nothing eligible, nothing deleted, checkpoint unchanged
    const plans = await computeCutoffs(db.pool, TRACE_TABLES, 90);
    expect(plans.find((p) => p.key === agentId)).toBeUndefined();
    const cp = await getPruneCheckpoint(db.pool, 'trace', agentId);
    expect(cp?.seq).toBe(5);
  });

  it('SCOPE-I-6 BLOCKER: INCREMENTAL verify survives a prune on a fresh (cold-cache) process', async () => {
    const agentId = await seedTrace(10); // 0..9
    await setBatched(agentId, 9);
    await ageRows(agentId, 9, 100);
    // warm the incremental cache (verifies genesis..9), then prune the prefix
    expect(await verifyAgentChainIncremental(db.pool, agentId)).toEqual({ ok: true });
    await prune(agentId);
    await appendTrace(db.pool, { agentId, kind: 'inference', detail: { i: 10 } }); // seq 10

    // Simulate a RESTART: cold cache. Pre-fix this would scan seq>-1, get only
    // seq 10, verifyChain from genesis → spurious {ok:false, seq gap}. Now it
    // anchors at the durable checkpoint.
    _clearVerifyCache();
    expect(await verifyAgentChainIncremental(db.pool, agentId)).toEqual({ ok: true });
  });

  it('re-enables the append-only trigger after pruning (direct DELETE still rejected)', async () => {
    const agentId = await seedTrace(4);
    await setBatched(agentId, 3);
    await ageRows(agentId, 3, 100);
    await prune(agentId);

    // trigger is enabled again
    const trig = await db.pool.query<{ tgenabled: string }>(
      `SELECT t.tgenabled FROM pg_trigger t
         WHERE t.tgname = 'trace_records_append_only'
           AND t.tgrelid = 'trace_records'::regclass`,
    );
    expect(trig.rows[0]?.tgenabled).toBe('O'); // 'O' = enabled (origin)

    // a direct delete is rejected by the restored trigger
    await appendTrace(db.pool, { agentId, kind: 'inference', detail: { i: 4 } });
    await expect(
      db.pool.query('DELETE FROM trace_records WHERE agent_id = $1', [agentId]),
    ).rejects.toThrow(/append-only/);
  });
});

describe('audit prune — owner stream (SCOPE-I-6)', () => {
  let ownerCounter = 0;
  function uniqueOwner(): string {
    return '0xab' + String(ownerCounter++).padStart(4, '0') + 'cd'.repeat(17);
  }

  async function seedOwner(owner: string, n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) await appendOwnerRecord(db.pool, owner, 'digest', { i });
  }
  async function setOwnerBatched(owner: string, seq: number): Promise<void> {
    await db.pool.query(
      `INSERT INTO owner_audit_cursor (owner_addr, last_batched_seq) VALUES ($1, $2)
       ON CONFLICT (owner_addr) DO UPDATE SET last_batched_seq = EXCLUDED.last_batched_seq`,
      [owner, seq],
    );
  }
  async function ageOwner(owner: string, maxSeq: number, days: number): Promise<void> {
    await db.pool.query('ALTER TABLE owner_records DISABLE TRIGGER owner_records_append_only');
    await db.pool.query(
      `UPDATE owner_records SET created_at = now() - ($3 || ' days')::interval
         WHERE owner_addr = $1 AND seq <= $2`,
      [owner, maxSeq, String(days)],
    );
    await db.pool.query('ALTER TABLE owner_records ENABLE TRIGGER owner_records_append_only');
  }
  async function pruneOwner(owner: string): Promise<void> {
    const plans = await computeCutoffs(db.pool, OWNER_TABLES, 90);
    const client = await db.pool.connect();
    try {
      for (const plan of plans.filter((p) => p.key === owner)) await pruneStream(client, OWNER_TABLES, plan);
    } finally {
      client.release();
    }
  }

  it('prunes archived+old owner records; full + incremental verify survive from the checkpoint', async () => {
    const owner = uniqueOwner();
    await seedOwner(owner, 8); // seq 0..7
    await setOwnerBatched(owner, 7);
    await ageOwner(owner, 7, 100);
    expect(await verifyOwnerChain(db.pool, owner)).toEqual({ ok: true });

    await pruneOwner(owner);

    const cp = await getPruneCheckpoint(db.pool, 'owner', owner);
    expect(cp?.seq).toBe(7);
    await appendOwnerRecord(db.pool, owner, 'digest', { i: 8 }); // seq 8, links to the pruned head
    expect(await verifyOwnerChain(db.pool, owner)).toEqual({ ok: true });

    // incremental on a cold cache must also anchor at the checkpoint (BLOCKER)
    _clearOwnerVerifyCache();
    expect(await verifyOwnerChainIncremental(db.pool, owner)).toEqual({ ok: true });
  });

  it('never prunes not-yet-batched owner records', async () => {
    const owner = uniqueOwner();
    await seedOwner(owner, 8);
    await setOwnerBatched(owner, 3); // only 0..3 archived
    await ageOwner(owner, 7, 100);
    const plan = (await computeCutoffs(db.pool, OWNER_TABLES, 90)).find((p) => p.key === owner);
    expect(plan?.cutoffSeq).toBe(3);
    await pruneOwner(owner);
    const remaining = await db.pool.query<{ c: string }>(
      'SELECT count(*)::text AS c FROM owner_records WHERE owner_addr = $1',
      [owner],
    );
    expect(Number(remaining.rows[0]?.c)).toBe(4); // 4..7 kept
    expect(await verifyOwnerChain(db.pool, owner)).toEqual({ ok: true });
  });
});
