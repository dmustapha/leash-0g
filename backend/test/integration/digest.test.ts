import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { PrivateKey } from 'eciesjs';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { buildTestApp, ownerAuth, FakeChainOps } from '../helpers/app.js';
import { DigestService } from '../../src/digest/service.js';
import { appendTrace } from '../../src/trace/trace-store.js';
import { appendOwnerRecord, listOwnerRecords } from '../../src/store/owner-records.js';
import { patchOwnerSettings, setTelegramChat, getOwnerSettings } from '../../src/store/owner-settings.js';
import { createLink, createDelegation, transitionDelegation } from '../../src/coordination/store.js';
import { StreamBatcher, ownerStreamSource, type StorageUploader } from '../../src/audit/batcher.js';
import { eciesDecrypt } from '../../src/crypto/ecies.js';

/**
 * D4 digest (spec §8 "Digest" row) + D5 owner-stream batcher (defer/drain).
 * The 0G live round-trip rides the live lane (owner-stream.live.test.ts).
 */

let db: TestDb;
let ownerCounter = 0;
function uniqueOwner(): string {
  return '0xc5' + String(ownerCounter++).padStart(4, '0') + 'aa'.repeat(17);
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

function digestService(chain: FakeChainOps): DigestService {
  return new DigestService({ pool: db.pool, chain, settings: { digestDefaultHourUtc: 8 } });
}

async function seedActivity(owner: string, accountAddr: string): Promise<string> {
  const agentId = await seedAgent(db.pool, { ownerAddr: owner, name: 'worker', accountAddr });
  await appendTrace(db.pool, {
    agentId,
    kind: 'action',
    detail: { txHash: '0x' + 'aa'.repeat(32), valueWei: '2000000000000000000', to: '0x' + '9c'.repeat(20) },
  });
  await appendTrace(db.pool, {
    agentId,
    kind: 'action',
    detail: { txHash: '0x' + 'bb'.repeat(32), valueWei: '1000000000000000000', to: '0x' + '9c'.repeat(20) },
  });
  await appendTrace(db.pool, { agentId, kind: 'block', detail: { rule: 'x' } });
  await appendTrace(db.pool, {
    agentId,
    kind: 'consent',
    approvalId: '00000000-0000-4000-8000-000000000001',
    decision: 'approve',
    decidedBy: 'owner',
  });
  return agentId;
}

describe('D4 — aggregation correctness', () => {
  it('sums spend from action traces, counts activity per agent, computes per-link terminal buckets', async () => {
    const owner = uniqueOwner();
    const account = '0x' + 'd1'.repeat(20);
    const chain = new FakeChainOps();
    chain.balances.set(account.toLowerCase(), 7n * 10n ** 18n);
    const svc = digestService(chain);
    const agentId = await seedActivity(owner, account);
    const peerId = await seedAgent(db.pool, { ownerAddr: owner, name: 'peer' });
    const link = await createLink(db.pool, { ownerAddr: owner, fromAgentId: agentId, toAgentId: peerId, mode: 'auto' });
    const d = await createDelegation(db.pool, {
      linkId: link.id,
      fromAgentId: agentId,
      toAgentId: peerId,
      kind: 'task',
      payload: {},
      status: 'pending',
      expiresAt: new Date(Date.now() + 600_000),
    });
    await transitionDelegation(db.pool, d.id, ['pending'], 'accepted');
    await transitionDelegation(db.pool, d.id, ['accepted'], 'completed', {
      result: { txHash: '0x1' },
      decidedAt: true,
    });

    const { digest } = await svc.compute(owner);
    const worker = digest.agents.find((a) => a.agentId === agentId);
    expect(worker?.spendWei).toBe('3000000000000000000'); // 2 + 1
    expect(worker?.actions).toBe(2);
    expect(worker?.blocks).toBe(1);
    expect(worker?.approvals.approved).toBe(1);
    expect(worker?.balanceWei).toBe((7n * 10n ** 18n).toString());
    expect(worker?.balanceChangeWei).toBeNull(); // no snapshot yet — honest
    const linkDigest = digest.links.find((l) => l.linkId === link.id);
    expect(linkDigest?.byStatus['completed']).toBe(1);
    expect(digest.totals.spendWei).toBe('3000000000000000000');
    expect(digest.empty).toBe(false);
  });

  it('balance change = snapshot delta after a mark; "since" boundary is exact (no double-count)', async () => {
    const owner = uniqueOwner();
    const account = '0x' + 'd2'.repeat(20);
    const chain = new FakeChainOps();
    chain.balances.set(account.toLowerCase(), 10n * 10n ** 18n);
    const svc = digestService(chain);
    const agentId = await seedActivity(owner, account);

    const first = await svc.mark(owner);
    expect(first.totals.spendWei).toBe('3000000000000000000');

    // Nothing new: the next digest is empty — the cursor moved exactly.
    const { digest: quiet } = await svc.compute(owner);
    expect(quiet.totals.actions).toBe(0);
    expect(quiet.empty).toBe(true);

    // New activity + balance moves down: delta is NET (label = balance change).
    await appendTrace(db.pool, {
      agentId,
      kind: 'action',
      detail: { txHash: '0x' + 'cc'.repeat(32), valueWei: '500000000000000000' },
    });
    chain.balances.set(account.toLowerCase(), 9n * 10n ** 18n);
    const { digest: second } = await svc.compute(owner);
    const worker = second.agents.find((a) => a.agentId === agentId);
    expect(worker?.actions).toBe(1); // ONLY the new action — boundary exact
    expect(worker?.spendWei).toBe('500000000000000000');
    expect(worker?.balanceChangeWei).toBe((-1n * 10n ** 18n).toString());
  });

  it('mark appends the owner-stream digest record transactionally with the cursor advance', async () => {
    const owner = uniqueOwner();
    const chain = new FakeChainOps();
    const svc = digestService(chain);
    await seedActivity(owner, '0x' + 'd3'.repeat(20));
    await svc.mark(owner);
    const records = await listOwnerRecords(db.pool, owner);
    const digestRec = records.find((r) => r.kind === 'digest');
    expect(digestRec).toBeDefined();
    const settings = await getOwnerSettings(db.pool, owner);
    expect(settings.digestCursor).not.toBeNull();
  });

  it('a manual mark racing the scheduled push produces serialized digests, never a double-count', async () => {
    const owner = uniqueOwner();
    const account = '0x' + 'd4'.repeat(20);
    const chain = new FakeChainOps();
    const svc = digestService(chain);
    const agentId = await seedActivity(owner, account);
    void agentId;
    const [a, b] = await Promise.all([svc.mark(owner), svc.mark(owner)]);
    // One digest carries the 2 actions; the other (serialized after) is empty.
    const counts = [a.totals.actions, b.totals.actions].sort();
    expect(counts).toEqual([0, 2]);
    const records = await listOwnerRecords(db.pool, owner);
    expect(records.filter((r) => r.kind === 'digest')).toHaveLength(2);
  });
});

describe('D4 — scheduler', () => {
  it('pushes once when the hour has passed, skips empty digests, never double-sends the same day', async () => {
    const owner = uniqueOwner();
    const account = '0x' + 'd5'.repeat(20);
    const chain = new FakeChainOps();
    const svc = digestService(chain);
    await seedActivity(owner, account);
    await setTelegramChat(db.pool, owner, 'chat-1');
    await patchOwnerSettings(db.pool, owner, { digestHourUtc: 0 }); // always due

    const pushes: Array<{ chatId: string; text: string }> = [];
    const push = async (_o: string, chatId: string, text: string): Promise<void> => {
      pushes.push({ chatId, text });
    };
    const now = new Date();
    expect(await svc.scheduledTick(now, push)).toBe(1);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.text).toContain('worker');
    // Same day, second tick: nothing (lastPushDate marks the day done).
    expect(await svc.scheduledTick(now, push)).toBe(0);
    expect(pushes).toHaveLength(1);
  });

  it('an empty fleet is skipped without a push (and not re-checked all day)', async () => {
    const owner = uniqueOwner();
    const chain = new FakeChainOps();
    const svc = digestService(chain);
    await setTelegramChat(db.pool, owner, 'chat-2');
    await patchOwnerSettings(db.pool, owner, { digestHourUtc: 0 });
    const pushes: string[] = [];
    const tick1 = await svc.scheduledTick(new Date(), async (_o, _c, text) => {
      pushes.push(text);
    });
    expect(tick1).toBe(0);
    expect(pushes).toHaveLength(0);
    // No digest record was appended for the empty skip (no fake mark).
    const records = await listOwnerRecords(db.pool, owner);
    expect(records.filter((r) => r.kind === 'digest')).toHaveLength(0);
  });

  it('opt-out is respected', async () => {
    const owner = uniqueOwner();
    const chain = new FakeChainOps();
    const svc = digestService(chain);
    await seedActivity(owner, '0x' + 'd6'.repeat(20));
    await setTelegramChat(db.pool, owner, 'chat-3');
    await patchOwnerSettings(db.pool, owner, { digestHourUtc: 0, digestOptout: true });
    expect(
      await svc.scheduledTick(new Date(), async () => {
        throw new Error('must not push');
      }),
    ).toBe(0);
  });
});

describe('digest routes', () => {
  it('GET /api/digest previews without advancing; POST /api/digest/mark advances', async () => {
    const owner = uniqueOwner();
    const t = buildTestApp(db.pool);
    const agentId = await seedAgent(db.pool, { ownerAddr: owner, name: 'route-agent' });
    await appendTrace(db.pool, { agentId, kind: 'action', detail: { txHash: '0x1', valueWei: '5' } });

    const preview = await request(t.app).get('/api/digest').set('authorization', ownerAuth(owner));
    expect(preview.status).toBe(200);
    expect(preview.body.digest.totals.actions).toBe(1);
    // Preview again: still 1 (cursor untouched).
    const preview2 = await request(t.app).get('/api/digest').set('authorization', ownerAuth(owner));
    expect(preview2.body.digest.totals.actions).toBe(1);

    const mark = await request(t.app).post('/api/digest/mark').set('authorization', ownerAuth(owner)).send({});
    expect(mark.status).toBe(200);
    expect(mark.body.digest.totals.actions).toBe(1);
    const after = await request(t.app).get('/api/digest').set('authorization', ownerAuth(owner));
    expect(after.body.digest.totals.actions).toBe(0); // advanced
  });
});

describe('D5 — owner-stream batcher (defer → drain)', () => {
  class MemoryUploader implements StorageUploader {
    public uploads: Buffer[] = [];
    async upload(data: Buffer): Promise<{ root: string; txHash: string }> {
      this.uploads.push(data);
      return { root: '0x' + String(this.uploads.length).padStart(64, '0'), txHash: '0x' + 'f1'.repeat(32) };
    }
  }

  it('defers while no stream pubkey exists, then drains the FULL backlog from seq 0', async () => {
    const owner = uniqueOwner();
    const key = new PrivateKey();
    const uploader = new MemoryUploader();
    const batcher = new StreamBatcher({ pool: db.pool, uploader }, ownerStreamSource, {
      maxRecords: 1,
      maxAgeMs: 0,
    });
    // Records append from seq 0 BEFORE any key exists (S10).
    await appendOwnerRecord(db.pool, owner, 'alert', { n: 0 });
    await appendOwnerRecord(db.pool, owner, 'alert', { n: 1 });
    await batcher.flushOnce();
    expect(uploader.uploads).toHaveLength(0); // deferred, NOT failed

    await patchOwnerSettings(db.pool, owner, { streamPubkey: key.publicKey.toHex() });
    await appendOwnerRecord(db.pool, owner, 'digest', { n: 2 });
    await batcher.flushOnce();
    expect(uploader.uploads).toHaveLength(1);

    // Owner-only decrypt: the full backlog (seq 0..2) is in the batch.
    const upload = uploader.uploads[0];
    if (!upload) throw new Error('upload missing');
    const plaintext = eciesDecrypt(key.secret, upload).toString('utf8');
    const lines = plaintext.trim().split('\n').map((l) => JSON.parse(l) as { seq: number });
    expect(lines.map((l) => l.seq)).toEqual([0, 1, 2]);

    // Wrong key CANNOT decrypt.
    const stranger = new PrivateKey();
    expect(() => eciesDecrypt(stranger.secret, upload)).toThrow();

    // Batch row recorded with the right range.
    const batches = await db.pool.query<{ seq_from: string; seq_to: string }>(
      `SELECT seq_from, seq_to FROM owner_audit_batches WHERE owner_addr = $1`,
      [owner.toLowerCase()],
    );
    expect(batches.rows[0]?.seq_from).toBe('0');
    expect(batches.rows[0]?.seq_to).toBe('2');
  });

  it('the cursor advances so a second flush uploads only NEW records', async () => {
    const owner = uniqueOwner();
    const key = new PrivateKey();
    const uploader = new MemoryUploader();
    const batcher = new StreamBatcher({ pool: db.pool, uploader }, ownerStreamSource, {
      maxRecords: 1,
      maxAgeMs: 0,
    });
    await patchOwnerSettings(db.pool, owner, { streamPubkey: key.publicKey.toHex() });
    await appendOwnerRecord(db.pool, owner, 'alert', { n: 0 });
    await batcher.flushOnce();
    await appendOwnerRecord(db.pool, owner, 'alert', { n: 1 });
    await batcher.flushOnce();
    expect(uploader.uploads).toHaveLength(2);
    const second = uploader.uploads[1];
    if (!second) throw new Error('missing');
    const lines = eciesDecrypt(key.secret, second).toString('utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0] ?? '{}') as { seq: number }).seq).toBe(1);
  });
});
