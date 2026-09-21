// LIVE: D5 owner-stream 0G round-trip (spec §8 "0G live lane" row): emitted
// alerts + a digest land as owner_records → batched to REAL 0G Storage →
// downloaded → owner-decrypted → contents match the emitted records; chain
// integrity verifiable WITHOUT decrypting.
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrivateKey } from 'eciesjs';
import { createTestDb } from '../test/helpers/db.js';
import { ZeroGStorage } from '../src/audit/storage.js';
import { StreamBatcher, ownerStreamSource } from '../src/audit/batcher.js';
import { AlertService } from '../src/alerts/service.js';
import { SseHub } from '../src/sse/hub.js';
import { appendOwnerRecord, listOwnerRecords } from '../src/store/owner-records.js';
import { patchOwnerSettings } from '../src/store/owner-settings.js';
import { verifyChain, type ChainedRecord } from '../src/crypto/hashchain.js';
import { eciesDecrypt } from '../src/crypto/ecies.js';
import { requireEnv, retry } from './helpers.js';

describe('owner-stream → 0G Storage round-trip (live testnet)', () => {
  it('batches the owner loop to 0G, owner decrypts, contents match, integrity verifies without decrypt', async () => {
    const db = await createTestDb();
    try {
      const owner = '0x' + randomUUID().replaceAll('-', '').slice(0, 40);
      const ownerKey = new PrivateKey();
      const hub = new SseHub();
      const alerts = new AlertService({ pool: db.pool, hub, settings: { alertRatePerOwnerPerHour: 1000 } });

      // The loop: two alerts + one digest record (unique content per run —
      // 0G content-addresses by Merkle root).
      const a1 = await alerts.emit(owner, {
        class: 'info',
        kind: 'revoked',
        summary: `live drill ${randomUUID()}`,
      });
      const a2 = await alerts.emit(owner, {
        class: 'decision',
        kind: 'approval_required',
        summary: `live decision ${randomUUID()}`,
        refs: { approvalId: randomUUID() },
      });
      expect(a1).not.toBeNull();
      expect(a2).not.toBeNull();
      await appendOwnerRecord(db.pool, owner, 'digest', { totals: { spendWei: '0' }, nonce: randomUUID() });

      await patchOwnerSettings(db.pool, owner, { streamPubkey: ownerKey.publicKey.toHex() });

      const uploads: Array<{ root: string; txHash: string; data: Buffer }> = [];
      const storage = new ZeroGStorage({
        indexerUrl: requireEnv('ZERO_G_STORAGE_INDEXER'),
        rpcUrl: requireEnv('ZERO_G_RPC'),
        opsPrivateKey: requireEnv('OPS_PRIVATE_KEY'),
      });
      const batcher = new StreamBatcher(
        {
          pool: db.pool,
          uploader: {
            async upload(data: Buffer) {
              const res = await storage.upload(data);
              uploads.push({ ...res, data });
              return res;
            },
          },
        },
        ownerStreamSource,
        { maxRecords: 1, maxAgeMs: 0 },
      );
      await batcher.flushOnce();
      const upload = uploads.find((u) => u !== undefined);
      if (!upload) throw new Error('owner-stream batch did not upload');
      console.log(`owner-stream batch: root=${upload.root} tx=${upload.txHash}`);

      // Download from REAL 0G Storage (node sync can lag — retry).
      const downloaded = await retry(() => storage.download(upload.root), 6, 5_000);
      expect(downloaded.equals(upload.data)).toBe(true);

      // Owner-only decrypt; contents match the emitted loop records.
      const plaintext = eciesDecrypt(ownerKey.secret, downloaded).toString('utf8');
      const records = plaintext
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as ChainedRecord & { kind: string });
      expect(records).toHaveLength(3);
      expect(records.map((r) => r.kind)).toEqual(['alert', 'alert', 'digest']);
      const stored = await listOwnerRecords(db.pool, owner);
      expect(records.map((r) => r.hash)).toEqual(stored.map((r) => r.hash));

      // Wrong key fails.
      const stranger = new PrivateKey();
      expect(() => eciesDecrypt(stranger.secret, downloaded)).toThrow();

      // Two-tier honesty (00 §7): integrity verifiable WITHOUT decrypting —
      // a third party checks the hash chain over the stored records alone.
      const verdict = verifyChain(stored as unknown as ChainedRecord[]);
      expect(verdict.ok).toBe(true);
    } finally {
      await db.drop();
    }
  }, 240_000);
});
