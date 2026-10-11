// INFRA-2 (SCOPE-INFRA-2, HIGH — the real home of X4-under-two-instances):
// prove against a REAL Postgres that two backend instances sharing one DB
// resolve to EXACTLY ONE runtime-lease holder (the fail-open the F-6 lease
// prevents — the 2026-10-04 incident where a branch deploy + a stray local
// backend both looped the same agents). The unit test (runtime-lease.test.ts)
// fakes the grant; this exercises the actual pg_try_advisory_lock session lock
// + the connection-death handoff.
//
// NOTE: the lease holds its client for the process lifetime (never released to
// the pool), so pool.end() HANGS unless the lease is released first — every
// test releases its leases before ending pools.
import { describe, it, expect } from 'vitest';
import { createDirectPool } from '../../src/db/pool.js';
import { RuntimeLease } from '../../src/runtime/lease.js';
import { resolveTestDbUrl } from '../helpers/db.js';

const URL = resolveTestDbUrl();

describe('INFRA-2 runtime lease — two instances, one DB', () => {
  it('grants to exactly one contender, then hands off once the holder is gone', async () => {
    const poolA = createDirectPool(URL);
    const poolB = createDirectPool(URL);
    const a = new RuntimeLease(poolA, () => undefined);
    const b = new RuntimeLease(poolB, () => undefined);
    try {
      // First instance wins the global advisory lock.
      expect(await a.tryAcquire()).toBe(true);
      expect(a.held()).toBe(true);

      // Second instance, SEPARATE session → same lock is held → must NOT acquire.
      // This is the no-double-holder / no-double-looping guarantee (X4 / F-6).
      expect(await b.tryAcquire()).toBe(false);
      expect(b.held()).toBe(false);
      expect(await b.tryAcquire()).toBe(false); // stays deferred while A holds

      // Holder "dies": release the lease then destroy its connection. A session
      // advisory lock dies with its connection, so ending poolA frees the lock
      // (the fail-safe handoff — in prod this is SIGTERM → pool.end → exit).
      a.release();
      await poolA.end();

      expect(await b.tryAcquire()).toBe(true); // B legitimately takes over
      expect(b.held()).toBe(true);
    } finally {
      a.release();
      b.release();
      await poolA.end().catch(() => undefined); // idempotent if already ended
      await poolB.end().catch(() => undefined);
    }
  });
});
