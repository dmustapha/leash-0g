import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import {
  insertDirectionDraft,
  getDirection,
  confirmDirection,
  listConfirmedUnapplied,
  markDirectionApplied,
  pruneStaleDraftDirections,
} from '../../src/store/directions.js';
import { appendMemory, listRecentMemory, countMemory } from '../../src/store/agent-memory.js';
import type { DirectionDraft } from '../../src/direction/direction.js';
import type { AgentGoal } from '../../src/types.js';

let db: TestDb;
const OWNER = '0x' + '7a'.repeat(20);
const OTHER = '0x' + '8b'.repeat(20);
const BENE = '0x' + '11'.repeat(20);
function effGoal(targetBalanceWei: string): AgentGoal {
  return { type: 'treasury', beneficiary: BENE, targetBalanceWei, topUpWei: '500' };
}

function draft(agentId: string, targetBalanceWei: string): DirectionDraft {
  return {
    agentId,
    currentRole: 'treasury',
    understanding: 'raise the target',
    goalPatch: { targetBalanceWei },
    moneyPower: 'can-move-money',
    unsureFields: [],
    confidence: 'high',
  };
}

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

describe('directions store lifecycle', () => {
  it('insert draft -> confirm (CAS) -> apply (CAS, idempotent)', async () => {
    const agentId = await seedAgent(db.pool, { ownerAddr: OWNER });
    const row = await insertDirectionDraft(db.pool, { agentId, ownerAddr: OWNER, intent: 'top to 2000', draft: draft(agentId, '2000') });
    expect(row.status).toBe('draft');

    const confirmed = await confirmDirection(db.pool, row.id, effGoal('2000'));
    expect(confirmed?.status).toBe('confirmed');
    // double-confirm is a no-op
    expect(await confirmDirection(db.pool, row.id, effGoal('2000'))).toBeNull();

    const pending = await listConfirmedUnapplied(db.pool, agentId);
    expect(pending).toHaveLength(1);

    const applied = await markDirectionApplied(db.pool, row.id);
    expect(applied?.status).toBe('applied');
    // idempotent: second apply is a no-op
    expect(await markDirectionApplied(db.pool, row.id)).toBeNull();
    expect(await listConfirmedUnapplied(db.pool, agentId)).toHaveLength(0);
  });

  it('confirming a newer directive SUPERSEDES an older confirmed-unapplied one', async () => {
    const agentId = await seedAgent(db.pool, { ownerAddr: OWNER });
    const first = await insertDirectionDraft(db.pool, { agentId, ownerAddr: OWNER, intent: 'a', draft: draft(agentId, '10') });
    const second = await insertDirectionDraft(db.pool, { agentId, ownerAddr: OWNER, intent: 'b', draft: draft(agentId, '20') });
    await confirmDirection(db.pool, first.id, effGoal('10'));
    await confirmDirection(db.pool, second.id, effGoal('20'));
    const pending = await listConfirmedUnapplied(db.pool, agentId, 5);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe(second.id);
    expect((await getDirection(db.pool, first.id))?.status).toBe('superseded');
  });

  it('edit-then-confirm overwrites the stored draft', async () => {
    const agentId = await seedAgent(db.pool, { ownerAddr: OWNER });
    const row = await insertDirectionDraft(db.pool, { agentId, ownerAddr: OWNER, intent: 'x', draft: draft(agentId, '1') });
    const edited = draft(agentId, '999');
    const confirmed = await confirmDirection(db.pool, row.id, effGoal('999'), edited);
    expect(confirmed?.draft.goalPatch).toEqual({ targetBalanceWei: '999' });
  });
});

describe('pruneStaleDraftDirections (M-01)', () => {
  it('drops abandoned draft rows older than the TTL, keeps fresh drafts AND confirmed rows', async () => {
    const agentId = await seedAgent(db.pool, { ownerAddr: OWNER, goal: effGoal('1000') as unknown as Record<string, unknown> });
    const oldDraft = await insertDirectionDraft(db.pool, { agentId, ownerAddr: OWNER, intent: 'old', draft: draft(agentId, '1') });
    const freshDraft = await insertDirectionDraft(db.pool, { agentId, ownerAddr: OWNER, intent: 'fresh', draft: draft(agentId, '2') });
    const oldConfirmed = await insertDirectionDraft(db.pool, { agentId, ownerAddr: OWNER, intent: 'confirmed', draft: draft(agentId, '3') });
    await confirmDirection(db.pool, oldConfirmed.id, effGoal('3'));
    // backdate the old draft AND the confirmed row past the TTL
    await db.pool.query(`UPDATE directions SET created_at = now() - interval '48 hours' WHERE id = ANY($1::uuid[])`, [[oldDraft.id, oldConfirmed.id]]);

    const dropped = await pruneStaleDraftDirections(db.pool, OWNER, 24 * 3600);
    expect(dropped).toBe(1); // only the old DRAFT
    expect(await getDirection(db.pool, oldDraft.id)).toBeNull(); // gone
    expect((await getDirection(db.pool, freshDraft.id))?.status).toBe('draft'); // fresh kept
    expect((await getDirection(db.pool, oldConfirmed.id))?.status).toBe('confirmed'); // confirmed kept (audit)
  });

  it('is owner-scoped: never prunes another owner drafts', async () => {
    const a = await seedAgent(db.pool, { ownerAddr: OTHER, goal: effGoal('1000') as unknown as Record<string, unknown> });
    const row = await insertDirectionDraft(db.pool, { agentId: a, ownerAddr: OTHER, intent: 'x', draft: draft(a, '1') });
    await db.pool.query(`UPDATE directions SET created_at = now() - interval '48 hours' WHERE id = $1`, [row.id]);
    await pruneStaleDraftDirections(db.pool, OWNER, 24 * 3600); // prune OWNER, not OTHER
    expect((await getDirection(db.pool, row.id))?.status).toBe('draft');
  });
});

describe('agent_memory rolling window', () => {
  it('appends with monotonic seq, prunes to the window cap, newest-first read', async () => {
    const agentId = await seedAgent(db.pool, { ownerAddr: OWNER });
    for (let i = 0; i < 6; i++) await appendMemory(db.pool, { agentId, kind: 'finding', content: { i } }, 3);
    expect(await countMemory(db.pool, agentId)).toBe(3);
    const recent = await listRecentMemory(db.pool, agentId, 10);
    expect(recent.map((r) => (r.content as { i: number }).i)).toEqual([5, 4, 3]);
    expect(recent[0]?.seq).toBe(5);
  });

  it('content is immutable (UPDATE forbidden by trigger)', async () => {
    const agentId = await seedAgent(db.pool, { ownerAddr: OWNER });
    await appendMemory(db.pool, { agentId, kind: 'finding', content: { a: 1 } });
    await expect(
      db.pool.query(`UPDATE agent_memory SET content = '{"a":2}' WHERE agent_id = $1`, [agentId]),
    ).rejects.toThrow(/append-only|immutable/i);
  });
});
