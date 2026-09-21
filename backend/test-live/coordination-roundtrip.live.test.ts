// LIVE (spec §8 "0G live lane" + D3): cross-agent coordination round-trip —
// a pair coordination exchange produces trace records on BOTH agents' chains,
// both audit batches land on REAL 0G Storage ECIES-encrypted, and the two-tier
// proof holds:
//   OWNER tier: download both batches → decrypt each with ITS owner audit key
//   → correlate the exchange across the two chains via the shared delegationId.
//   THIRD-PARTY tier: verify both hash-chains + the batch Merkle-root
//   anchoring WITHOUT decrypting anything.
//   Wrong-key decrypt still FAILS (owner-only confidentiality).
// The pair's REASONING and on-chain act are proven elsewhere (role evals on
// real 0G Compute in evals.live.test.ts; the deployed pair E2E for the real
// act) — this test pins the audit/correlation claim end-to-end on live 0G.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrivateKey } from 'eciesjs';
import { createTestDb, seedAgent, type TestDb } from '../test/helpers/db.js';
import { SseHub } from '../src/sse/hub.js';
import { DelegationCoordinator } from '../src/coordination/coordinator.js';
import { createLink } from '../src/coordination/store.js';
import { getAgentById } from '../src/store/agents.js';
import { AuditBatcher } from '../src/audit/batcher.js';
import { ZeroGStorage } from '../src/audit/storage.js';
import { eciesDecrypt } from '../src/crypto/ecies.js';
import { verifyAgentChain } from '../src/trace/trace-store.js';
import { requireEnv, retry } from './helpers.js';

const OWNER = '0x' + '5a'.repeat(20);

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
}, 120_000);

afterAll(async () => {
  await db.drop();
});

describe('cross-agent coordination audit round-trip (live 0G Storage)', () => {
  it('both chains carry the exchange; owner correlates post-decrypt; third party verifies without decrypting', async () => {
    const storage = new ZeroGStorage({
      indexerUrl: requireEnv('ZERO_G_STORAGE_INDEXER'),
      rpcUrl: requireEnv('ZERO_G_RPC'),
      opsPrivateKey: requireEnv('OPS_PRIVATE_KEY'),
    });

    // Two agents, each with its OWN dedicated audit keypair (owner-held).
    const keyA = new PrivateKey();
    const keyB = new PrivateKey();
    const idA = await seedAgent(db.pool, {
      ownerAddr: OWNER,
      name: 'live-sentinel',
      accountAddr: '0x' + 'a1'.repeat(20),
      auditPubkey: keyA.publicKey.toHex(),
    });
    const idB = await seedAgent(db.pool, {
      ownerAddr: OWNER,
      name: 'live-executor',
      accountAddr: '0x' + 'b1'.repeat(20),
      sessionKeyAddr: '0x' + 'b2'.repeat(20),
      tokenId: 'live-exec-token',
      auditPubkey: keyB.publicKey.toHex(),
    });
    await createLink(db.pool, { ownerAddr: OWNER, fromAgentId: idA, toAgentId: idB, mode: 'auto' });

    const hub = new SseHub();
    const coordinator = new DelegationCoordinator({
      pool: db.pool,
      hub,
      runtime: { nudge: () => undefined },
      settings: {
        delegationTtlMs: 600_000,
        delegationRatePerLinkPerHour: 100,
        delegationMaxPendingPerLink: 10,
        delegationPayloadMaxBytes: 16_384,
      },
    });

    // The pair exchange: A delegates → B accepts → B completes with a result.
    const agentA = await getAgentById(db.pool, idA);
    if (!agentA) throw new Error('seed failed');
    const delegation = await coordinator.issueDelegation({
      fromAgent: agentA,
      kind: 'transfer.request',
      payload: { beneficiary: '0x' + '9c'.repeat(20), amountWei: '5000000000000000', rationale: 'live round-trip' },
    });
    await coordinator.markAccepted(delegation.id);
    await coordinator.markCompleted(delegation.id, { txHash: '0x' + 'ee'.repeat(32) });

    // Flush BOTH agents' batches to REAL 0G Storage (force-due: maxAgeMs 0).
    const batcher = new AuditBatcher({ pool: db.pool, uploader: storage }, { maxRecords: 1, maxAgeMs: 0 });
    await retry(() => batcher.flushOnce(), 3, 10_000);

    const batches = await db.pool.query<{ agent_id: string; merkle_root: string; storage_tx: string }>(
      `SELECT agent_id, merkle_root, storage_tx FROM audit_batches WHERE agent_id = ANY($1::uuid[])`,
      [[idA, idB]],
    );
    const batchA = batches.rows.find((b) => b.agent_id === idA);
    const batchB = batches.rows.find((b) => b.agent_id === idB);
    if (!batchA || !batchB) throw new Error('both agents must have sealed a batch');
    console.log(`batch A root=${batchA.merkle_root} tx=${batchA.storage_tx}`);
    console.log(`batch B root=${batchB.merkle_root} tx=${batchB.storage_tx}`);

    // ---- OWNER tier: download → decrypt EACH with ITS key → correlate ----
    const cipherA = await retry(() => storage.download(batchA.merkle_root), 6, 5_000);
    const cipherB = await retry(() => storage.download(batchB.merkle_root), 6, 5_000);

    const plainA = eciesDecrypt(keyA.secret, cipherA).toString('utf8');
    const plainB = eciesDecrypt(keyB.secret, cipherB).toString('utf8');
    const recordsA = plainA.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    const recordsB = plainB.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

    const delegateRec = recordsA.find((r) => r['kind'] === 'delegate');
    const updateRecs = recordsB.filter((r) => r['kind'] === 'delegation_update');
    expect((delegateRec?.['detail'] as Record<string, unknown>)?.['delegationId']).toBe(delegation.id);
    const statuses = updateRecs.map((r) => (r['detail'] as Record<string, unknown>)['status']);
    expect(statuses).toContain('accepted');
    expect(statuses).toContain('completed');
    // Same delegationId on BOTH sides = the owner's cross-chain correlation key.
    for (const r of updateRecs) {
      expect((r['detail'] as Record<string, unknown>)['delegationId']).toBe(delegation.id);
    }
    // The issuer-side payload rides ONLY in the encrypted record (owner-visible).
    expect((delegateRec?.['detail'] as Record<string, unknown>)?.['payload']).toMatchObject({
      amountWei: '5000000000000000',
    });

    // Keys are NOT interchangeable: A's key cannot open B's batch, and a
    // stranger's key opens neither (owner-only decrypt, 00 §6b).
    expect(() => eciesDecrypt(keyA.secret, cipherB)).toThrow();
    const stranger = new PrivateKey();
    expect(() => eciesDecrypt(stranger.secret, cipherA)).toThrow();
    expect(() => eciesDecrypt(stranger.secret, cipherB)).toThrow();

    // ---- THIRD-PARTY tier: integrity WITHOUT decrypting (00 §7) ----
    // (a) both per-agent hash-chains verify from the durable records;
    expect((await verifyAgentChain(db.pool, idA)).ok).toBe(true);
    expect((await verifyAgentChain(db.pool, idB)).ok).toBe(true);
    // (b) the sealed batches are content-addressed on 0G Storage: the recorded
    // Merkle root IS the address the ciphertext was retrieved by (anchoring) —
    // no plaintext access was needed for either check.
    expect(cipherA.length).toBeGreaterThan(0);
    expect(cipherB.length).toBeGreaterThan(0);
  }, 600_000);
});
