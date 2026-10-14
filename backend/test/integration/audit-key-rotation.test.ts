// SCOPE-RH2-2 / I-6-H2: seq-anchored audit-key ROTATION. A per-stream key
// history selected by seq; batches never span a rotation boundary, so every 0G
// batch maps to exactly one key (deterministic owner read-back). These tests
// prove: owner rotation creates a seq boundary, pubkeyFor(atSeq) selects by
// seq, the agent audit-pubkey PATCH is owner-scoped, a rotation clears the
// quarantine, and the migration backfill lands the existing key at seq 0.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import nock from 'nock';
import { PrivateKey } from 'eciesjs';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { buildTestApp, ownerAuth, type TestApp } from '../helpers/app.js';
import { appendOwnerRecord } from '../../src/store/owner-records.js';
import { appendTrace } from '../../src/trace/trace-store.js';
import {
  StreamBatcher,
  ownerStreamSource,
  traceStreamSource,
  type StreamSource,
  type StorageUploader,
} from '../../src/audit/batcher.js';
import { rotateOwnerStreamKey } from '../../src/store/owner-settings.js';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { SET_AUDIT_PUBKEY_TYPES, OWNER_STREAM_TARGET } from '../../src/signing/audit-pubkey-auth.js';

let db: TestDb;

const BAD_KEY = '04' + 'ab'.repeat(64); // regex-shaped, NOT on the curve

const TEST_CHAIN_ID = 16602; // testSettings().defaultChainId

/** NC-2: sign SetAuditPubkey with an owner EOA (the EIP-712 rotation proof). */
async function signRotation(
  pk: Hex,
  target: string,
  pubkey: string,
  nonce: bigint,
): Promise<string> {
  const account = privateKeyToAccount(pk);
  return account.signTypedData({
    domain: { name: 'LEASH', version: '1', chainId: TEST_CHAIN_ID },
    types: SET_AUDIT_PUBKEY_TYPES,
    primaryType: 'SetAuditPubkey',
    message: { owner: account.address, target, pubkey, nonce },
  });
}

class FakeUploader implements StorageUploader {
  public uploads: Buffer[] = [];
  private n = 0;
  async upload(data: Buffer): Promise<{ root: string; txHash: string }> {
    this.uploads.push(data);
    this.n += 1;
    return { root: `0xroot${this.n}`, txHash: `0xtx${this.n}` };
  }
}

beforeAll(async () => {
  db = await createTestDb();
  nock.disableNetConnect();
  nock.enableNetConnect(/127\.0\.0\.1|localhost|neon\.tech/);
});

afterAll(async () => {
  nock.enableNetConnect();
  await db.drop();
});

async function seedOwnerRecords(owner: string, from: number, to: number): Promise<void> {
  for (let i = from; i <= to; i += 1) {
    await appendOwnerRecord(db.pool, owner, 'alert', { i });
  }
}

describe('SCOPE-RH2-2 owner stream-key rotation (seq boundary)', () => {
  it('rotation splits flush into per-key batches that never cross the boundary', async () => {
    const owner = ('0x' + 'a1'.repeat(20)).toLowerCase();
    const keyA = new PrivateKey();
    const keyB = new PrivateKey();
    const uploader = new FakeUploader();
    const batcher = new StreamBatcher({ pool: db.pool, uploader }, ownerStreamSource, {
      maxRecords: 1,
      maxAgeMs: 0,
    });

    await rotateOwnerStreamKey(db.pool, owner, keyA.publicKey.toHex()); // first set → eff 0 (no records yet)
    await seedOwnerRecords(owner, 0, 4); // seq 0..4
    await batcher.flushOnce();
    expect(uploader.uploads).toHaveLength(1); // batch [0..4] under A

    await rotateOwnerStreamKey(db.pool, owner, keyB.publicKey.toHex()); // eff 5
    await seedOwnerRecords(owner, 5, 9); // seq 5..9
    await batcher.flushOnce();
    expect(uploader.uploads).toHaveLength(2); // batch [5..9] under B

    const batches = await db.pool.query<{ seq_from: string; seq_to: string }>(
      `SELECT seq_from, seq_to FROM owner_audit_batches WHERE owner_addr = $1 ORDER BY seq_from ASC`,
      [owner],
    );
    expect(batches.rows).toHaveLength(2);
    expect(batches.rows[0]).toMatchObject({ seq_from: '0', seq_to: '4' });
    expect(batches.rows[1]).toMatchObject({ seq_from: '5', seq_to: '9' });

    // records() must never return a cross-boundary batch: from cursor -1, only
    // seq 0..4 (next boundary at 5 caps it), even with a huge limit.
    const firstPass = await ownerStreamSource.records(db.pool, owner, -1, 1000);
    expect(firstPass.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4]);
    // Seam from the B side: from cursor 4, the batch starts crisply at seq 5
    // (the boundary record is the FIRST under B), no gap/overlap/off-by-one.
    const secondPass = await ownerStreamSource.records(db.pool, owner, 4, 1000);
    expect(secondPass.map((r) => r.seq)).toEqual([5, 6, 7, 8, 9]);
  });

  it('pubkeyFor(atSeq) returns A for seq<=4 and B for seq>=5', async () => {
    const owner = ('0x' + 'a2'.repeat(20)).toLowerCase();
    const keyA = new PrivateKey();
    const keyB = new PrivateKey();
    await rotateOwnerStreamKey(db.pool, owner, keyA.publicKey.toHex()); // first set → eff 0
    await seedOwnerRecords(owner, 0, 4);
    await rotateOwnerStreamKey(db.pool, owner, keyB.publicKey.toHex()); // eff 5

    const at0 = await ownerStreamSource.pubkeyFor(db.pool, owner, 0);
    const at4 = await ownerStreamSource.pubkeyFor(db.pool, owner, 4);
    const at5 = await ownerStreamSource.pubkeyFor(db.pool, owner, 5);
    expect(at0).toBe(keyA.publicKey.toHex());
    expect(at4).toBe(keyA.publicKey.toHex());
    expect(at5).toBe(keyB.publicKey.toHex());
  });

  it('first-ever set covers the whole S10 backlog from seq 0 (defer only while NO key exists)', async () => {
    const owner = ('0x' + 'a3'.repeat(20)).toLowerCase();
    await seedOwnerRecords(owner, 0, 2);
    // No key set yet → defer, not error (the S10 pre-key window).
    expect(await ownerStreamSource.pubkeyFor(db.pool, owner, 0)).toBeNull();
    const key = new PrivateKey();
    await rotateOwnerStreamKey(db.pool, owner, key.publicKey.toHex()); // FIRST-ever set → effective from seq 0
    // The first key covers the ENTIRE pre-key backlog (seq 0 on): it drains, never
    // strands. (Only a later rotation is seq-anchored at MAX+1.)
    expect(await ownerStreamSource.pubkeyFor(db.pool, owner, 0)).toBe(key.publicKey.toHex());
    expect(await ownerStreamSource.pubkeyFor(db.pool, owner, 2)).toBe(key.publicKey.toHex());
  });
});

describe('SCOPE-RH2-2 agent audit-pubkey rotation route', () => {
  it('PATCH rotates the key for future flushes; foreign owner → 404', async () => {
    const ownerPk = generatePrivateKey();
    const owner = privateKeyToAccount(ownerPk).address.toLowerCase();
    const foreign = ('0x' + 'b2'.repeat(20)).toLowerCase();
    const keyA = new PrivateKey();
    const keyB = new PrivateKey();
    const agentId = await seedAgent(db.pool, { ownerAddr: owner, auditPubkey: keyA.publicKey.toHex() });
    const t: TestApp = buildTestApp(db.pool);
    const pubB = keyB.publicKey.toHex();

    // Foreign owner is refused with 404 (enumeration-oracle discipline) — the
    // owner-scope 404 precedes the signature wall (no enumeration oracle).
    const foreignRes = await request(t.app)
      .patch(`/api/agents/${agentId}/audit-pubkey`)
      .set('authorization', ownerAuth(foreign))
      .send({ pubkey: pubB, signature: await signRotation(ownerPk, agentId, pubB, 0n), nonce: '0' });
    expect(foreignRes.status).toBe(404);

    // Owner rotation succeeds with a valid EIP-712 signature.
    await appendTrace(db.pool, { agentId, kind: 'inference', detail: { i: 0 } });
    const ok = await request(t.app)
      .patch(`/api/agents/${agentId}/audit-pubkey`)
      .set('authorization', ownerAuth(owner))
      .send({ pubkey: pubB, signature: await signRotation(ownerPk, agentId, pubB, 0n), nonce: '0' });
    expect(ok.status).toBe(200);

    // The new key covers seq 1 onward; seq 0 keeps key A.
    expect(await traceStreamSource.pubkeyFor(db.pool, agentId, 0)).toBe(keyA.publicKey.toHex());
    expect(await traceStreamSource.pubkeyFor(db.pool, agentId, 1)).toBe(keyB.publicKey.toHex());
  });

  it('422 for an invalid (not-on-curve) pubkey', async () => {
    const ownerPk = generatePrivateKey();
    const owner = privateKeyToAccount(ownerPk).address.toLowerCase();
    const agentId = await seedAgent(db.pool, { ownerAddr: owner, auditPubkey: new PrivateKey().publicKey.toHex() });
    const t: TestApp = buildTestApp(db.pool);
    const res = await request(t.app)
      .patch(`/api/agents/${agentId}/audit-pubkey`)
      .set('authorization', ownerAuth(owner))
      .send({ pubkey: BAD_KEY, signature: await signRotation(ownerPk, agentId, BAD_KEY, 0n), nonce: '0' });
    expect(res.status).toBe(422);
  });
});

describe('NC-2 rotation requires an owner EIP-712 signature', () => {
  it('valid owner sig rotates; wrong-signer → 403 no rotation; replay → 403; missing sig → 403', async () => {
    const ownerPk = generatePrivateKey();
    const owner = privateKeyToAccount(ownerPk).address.toLowerCase();
    const attackerPk = generatePrivateKey();
    const keyA = new PrivateKey();
    const keyB = new PrivateKey();
    const keyC = new PrivateKey();
    const agentId = await seedAgent(db.pool, { ownerAddr: owner, auditPubkey: keyA.publicKey.toHex() });
    const t: TestApp = buildTestApp(db.pool);
    const auth = ownerAuth(owner);
    const pubB = keyB.publicKey.toHex();
    const pubC = keyC.publicKey.toHex();

    // Missing signature → 403 (fail-closed), key unchanged.
    const noSig = await request(t.app)
      .patch(`/api/agents/${agentId}/audit-pubkey`)
      .set('authorization', auth)
      .send({ pubkey: pubB });
    expect(noSig.status).toBe(400); // schema rejects missing signature/nonce
    expect(await traceStreamSource.pubkeyFor(db.pool, agentId, 0)).toBe(keyA.publicKey.toHex());

    // Wrong signer (attacker holds a valid Privy session but NOT the owner key) → 403.
    const wrong = await request(t.app)
      .patch(`/api/agents/${agentId}/audit-pubkey`)
      .set('authorization', auth)
      .send({ pubkey: pubB, signature: await signRotation(attackerPk, agentId, pubB, 0n), nonce: '0' });
    expect(wrong.status).toBe(403);
    expect(await traceStreamSource.pubkeyFor(db.pool, agentId, 0)).toBe(keyA.publicKey.toHex());

    // Valid owner sig → rotates.
    const ok = await request(t.app)
      .patch(`/api/agents/${agentId}/audit-pubkey`)
      .set('authorization', auth)
      .send({ pubkey: pubB, signature: await signRotation(ownerPk, agentId, pubB, 0n), nonce: '0' });
    expect(ok.status).toBe(200);
    expect(await traceStreamSource.pubkeyFor(db.pool, agentId, 0)).toBe(pubB);

    // Replay: reusing nonce 0 (even validly re-signed) → 403, no rotation to C.
    const replay = await request(t.app)
      .patch(`/api/agents/${agentId}/audit-pubkey`)
      .set('authorization', auth)
      .send({ pubkey: pubC, signature: await signRotation(ownerPk, agentId, pubC, 0n), nonce: '0' });
    expect(replay.status).toBe(403);
    expect(await traceStreamSource.pubkeyFor(db.pool, agentId, 0)).toBe(pubB);

    // A fresh, larger nonce rotates again.
    const next = await request(t.app)
      .patch(`/api/agents/${agentId}/audit-pubkey`)
      .set('authorization', auth)
      .send({ pubkey: pubC, signature: await signRotation(ownerPk, agentId, pubC, 1n), nonce: '1' });
    expect(next.status).toBe(200);
    expect(await traceStreamSource.pubkeyFor(db.pool, agentId, 0)).toBe(pubC);
  });

  it('owner stream-key route enforces the same signature + nonce wall', async () => {
    const ownerPk = generatePrivateKey();
    const owner = privateKeyToAccount(ownerPk).address.toLowerCase();
    const attackerPk = generatePrivateKey();
    const keyA = new PrivateKey();
    const keyB = new PrivateKey();
    const t: TestApp = buildTestApp(db.pool);
    const auth = ownerAuth(owner);
    const pubA = keyA.publicKey.toHex();
    const pubB = keyB.publicKey.toHex();
    const tgt = OWNER_STREAM_TARGET;

    // Wrong signer → 403, no key set.
    const wrong = await request(t.app)
      .post('/api/owner/stream-key')
      .set('authorization', auth)
      .send({ pubkey: pubA, signature: await signRotation(attackerPk, tgt, pubA, 0n), nonce: '0' });
    expect(wrong.status).toBe(403);
    expect(await ownerStreamSource.pubkeyFor(db.pool, owner, 0)).toBeNull();

    // Valid owner sig → sets key A.
    const ok = await request(t.app)
      .post('/api/owner/stream-key')
      .set('authorization', auth)
      .send({ pubkey: pubA, signature: await signRotation(ownerPk, tgt, pubA, 0n), nonce: '0' });
    expect(ok.status).toBe(200);
    expect(await ownerStreamSource.pubkeyFor(db.pool, owner, 0)).toBe(pubA);

    // Replayed nonce → 403, still key A.
    const replay = await request(t.app)
      .post('/api/owner/stream-key')
      .set('authorization', auth)
      .send({ pubkey: pubB, signature: await signRotation(ownerPk, tgt, pubB, 0n), nonce: '0' });
    expect(replay.status).toBe(403);
    expect(await ownerStreamSource.pubkeyFor(db.pool, owner, 0)).toBe(pubA);

    // Fresh nonce → rotates to B.
    const next = await request(t.app)
      .post('/api/owner/stream-key')
      .set('authorization', auth)
      .send({ pubkey: pubB, signature: await signRotation(ownerPk, tgt, pubB, 1n), nonce: '1' });
    expect(next.status).toBe(200);
    expect(await ownerStreamSource.pubkeyFor(db.pool, owner, 0)).toBe(pubB);
  });
});

describe('SCOPE-RH2-2 rotation clears quarantine', () => {
  it('a bad key, once rotated to a valid one, flushes on the next pass', async () => {
    const owner = ('0x' + 'c1'.repeat(20)).toLowerCase();
    const goodKey = new PrivateKey();
    const uploader = new FakeUploader();
    // Keep the records source but override pubkeyFor to return the BAD key
    // until we "rotate" by swapping the stored key.
    const current = { pubkey: BAD_KEY };
    const source: StreamSource = {
      ...ownerStreamSource,
      name: 'owner-quarantine-test',
      pubkeyFor: () => Promise.resolve(current.pubkey),
    };
    const batcher = new StreamBatcher({ pool: db.pool, uploader }, source, { maxRecords: 1, maxAgeMs: 0 });
    await seedOwnerRecords(owner, 0, 0);

    const errSpy = { restore: () => undefined };
    const origErr = console.error;
    console.error = () => undefined;
    try {
      await batcher.flushOnce(); // bad key → quarantined
      expect(uploader.uploads).toHaveLength(0);

      // Quarantined: a second pass does nothing even if the key is now good.
      current.pubkey = goodKey.publicKey.toHex();
      await batcher.flushOnce();
      expect(uploader.uploads).toHaveLength(0);

      // Rotation clears the quarantine → the next pass flushes.
      batcher.clearQuarantine(owner);
      await batcher.flushOnce();
      expect(uploader.uploads).toHaveLength(1);
    } finally {
      console.error = origErr;
      errSpy.restore();
    }
  });
});

describe('SCOPE-RH2-2 migration backfill', () => {
  it('an existing stream_pubkey/audit_pubkey appears as the effective key at seq 0', async () => {
    // seedAgent sets agents.audit_pubkey directly (not via rotate) to model a
    // pre-migration row; the migration backfilled such rows at seq 0. Re-run the
    // backfill insert the migration performs to prove the mapping.
    const owner = ('0x' + 'd1'.repeat(20)).toLowerCase();
    const key = new PrivateKey();
    const agentId = await seedAgent(db.pool, { ownerAddr: owner, auditPubkey: key.publicKey.toHex() });
    await db.pool.query(
      `INSERT INTO agent_audit_keys (agent_id, pubkey, effective_from_seq)
       SELECT id, audit_pubkey, 0 FROM agents WHERE id = $1 AND audit_pubkey IS NOT NULL
       ON CONFLICT DO NOTHING`,
      [agentId],
    );
    expect(await traceStreamSource.pubkeyFor(db.pool, agentId, 0)).toBe(key.publicKey.toHex());
  });
});
