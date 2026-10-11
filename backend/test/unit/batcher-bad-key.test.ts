// F-3: a stored auditPubKey that matches the shape regex but is not a point
// on secp256k1 made eciesjs throw "bad point: is not on curve" at every
// flush tick, forever. The batcher must (a) never let one bad key starve the
// other keys, and (b) quarantine the bad key instead of retrying it forever.
import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { StreamBatcher, type StreamSource, type StorageUploader } from '../../src/audit/batcher.js';

const BAD_KEY = '04' + 'ab'.repeat(64); // regex-shaped, NOT on the curve
const GOOD_KEY =
  '044f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa385b6b1b8ead809ca67454d9683fcf2ba03456d6fe2c4abe2b07f0fbdbb2f1c1';

function makeSource(pubkeys: Record<string, string>) {
  const pubkeyCalls: string[] = [];
  const committed: string[] = [];
  const oldest = new Date(Date.now() - 120_000); // past maxAgeMs → due
  const source: StreamSource = {
    name: 'test',
    pending: () => Promise.resolve(Object.keys(pubkeys).map((key) => ({ key, n: 1, oldest }))),
    pubkeyFor: (_pool, key) => {
      pubkeyCalls.push(key);
      return Promise.resolve(pubkeys[key] ?? null);
    },
    cursor: () => Promise.resolve(-1),
    records: () => Promise.resolve([{ seq: 0, record: { hello: 'world' } }]),
    commit: (_pool, key) => {
      committed.push(key);
      return Promise.resolve();
    },
  };
  return { source, pubkeyCalls, committed };
}

describe('StreamBatcher F-3 bad-key quarantine', () => {
  it('quarantines a not-on-curve key and keeps flushing healthy keys', async () => {
    const { source, pubkeyCalls, committed } = makeSource({ bad: BAD_KEY, good: GOOD_KEY });
    const uploads: Buffer[] = [];
    const uploader: StorageUploader = {
      upload: (data) => {
        uploads.push(data);
        return Promise.resolve({ root: '0xroot', txHash: '0xtx' });
      },
    };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const batcher = new StreamBatcher({ pool: {} as Pool, uploader }, source);

    await batcher.flushOnce();
    // The healthy key flushed despite the bad one in the same pass.
    expect(committed).toEqual(['good']);
    expect(uploads).toHaveLength(1);
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('PERMANENTLY skipped for bad'))).toBe(true);

    // Second pass: the bad key is quarantined — not even its pubkey is re-read.
    const badReadsAfterFirstPass = pubkeyCalls.filter((k) => k === 'bad').length;
    await batcher.flushOnce();
    expect(pubkeyCalls.filter((k) => k === 'bad').length).toBe(badReadsAfterFirstPass);
    // The healthy key keeps flushing on later passes.
    expect(committed).toEqual(['good', 'good']);
    errSpy.mockRestore();
  });

  it('keeps retry/backoff semantics for transient (non-key) failures', async () => {
    const { source } = makeSource({ good: GOOD_KEY });
    let attempts = 0;
    const uploader: StorageUploader = {
      upload: () => {
        attempts += 1;
        return Promise.reject(new Error('storage down'));
      },
    };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const batcher = new StreamBatcher({ pool: {} as Pool, uploader }, source, { retryBackoffMs: 0 });
    await batcher.flushOnce();
    await batcher.flushOnce();
    expect(attempts).toBe(2); // retried, NOT quarantined
    errSpy.mockRestore();
  });
});

describe('StreamBatcher drain (SCOPE-SHUTDOWN-1)', () => {
  it('resolves immediately when idle (nothing in flight)', async () => {
    const { source } = makeSource({ good: GOOD_KEY });
    const uploader: StorageUploader = { upload: () => Promise.resolve({ root: '0xr', txHash: '0xt' }) };
    const batcher = new StreamBatcher({ pool: {} as Pool, uploader }, source);
    await expect(batcher.drain()).resolves.toBeUndefined();
  });

  it('awaits an in-flight flush before resolving (so pool.end never races it)', async () => {
    const { source, committed } = makeSource({ good: GOOD_KEY });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const uploader: StorageUploader = {
      upload: async () => {
        await gate; // hold the flush mid-upload
        return { root: '0xr', txHash: '0xt' };
      },
    };
    const batcher = new StreamBatcher({ pool: {} as Pool, uploader }, source);

    const flush = batcher.flushOnce(); // in-flight, blocked on the gate
    await Promise.resolve();
    expect(committed).toEqual([]); // upload not done → not committed

    let drained = false;
    const drain = batcher.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false); // drain is WAITING on the in-flight flush

    release(); // let the upload complete
    await drain;
    await flush;
    expect(drained).toBe(true);
    expect(committed).toEqual(['good']); // the flush finished before drain resolved
  });
});
