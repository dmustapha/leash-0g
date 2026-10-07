// F-6: two backends sharing one DB must never double-run agent loops. The
// lease is a session advisory lock on a dedicated connection; only the
// holder runs loops, and a dropped lease connection fires onLost (fail-safe
// exit in production — the lock died with the connection).
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Pool } from 'pg';
import { RuntimeLease } from '../../src/runtime/lease.js';

function fakePool(grantSequence: boolean[]) {
  const clients: Array<EventEmitter & { release: ReturnType<typeof vi.fn> }> = [];
  let call = 0;
  const pool = {
    connect: () => {
      const client = Object.assign(new EventEmitter(), {
        release: vi.fn(),
        query: () => Promise.resolve({ rows: [{ ok: grantSequence[Math.min(call++, grantSequence.length - 1)] }] }),
      });
      clients.push(client);
      return Promise.resolve(client);
    },
  };
  return { pool: pool as unknown as Pool, clients };
}

describe('RuntimeLease (F-6)', () => {
  it('acquires when the lock is free and keeps the connection (not released)', async () => {
    const { pool, clients } = fakePool([true]);
    const lease = new RuntimeLease(pool, () => undefined);
    expect(lease.held()).toBe(false);
    expect(await lease.tryAcquire()).toBe(true);
    expect(lease.held()).toBe(true);
    expect(clients[0]?.release).not.toHaveBeenCalled();
  });

  it('does not hold when another instance has the lock; releases the probe connection', async () => {
    const { pool, clients } = fakePool([false]);
    const lease = new RuntimeLease(pool, () => undefined);
    expect(await lease.tryAcquire()).toBe(false);
    expect(lease.held()).toBe(false);
    expect(clients[0]?.release).toHaveBeenCalledOnce();
  });

  it('acquire() polls until the holder goes away', async () => {
    const { pool } = fakePool([false, false, true]);
    const lease = new RuntimeLease(pool, () => undefined, 1);
    await lease.acquire();
    expect(lease.held()).toBe(true);
  });

  it('fires onLost and drops held() when the lease connection errors', async () => {
    const { pool, clients } = fakePool([true]);
    const onLost = vi.fn();
    const lease = new RuntimeLease(pool, onLost);
    await lease.tryAcquire();
    clients[0]?.emit('error', new Error('connection terminated'));
    expect(lease.held()).toBe(false);
    expect(onLost).toHaveBeenCalledOnce();
  });

  it('acquire() survives transient connect failures and retries', async () => {
    let call = 0;
    const client = Object.assign(new EventEmitter(), {
      release: vi.fn(),
      query: () => Promise.resolve({ rows: [{ ok: true }] }),
    });
    const pool = {
      connect: () => (call++ === 0 ? Promise.reject(new Error('pool timeout')) : Promise.resolve(client)),
    } as unknown as Pool;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const lease = new RuntimeLease(pool, () => undefined, 1);
    await lease.acquire();
    expect(lease.held()).toBe(true);
    errSpy.mockRestore();
  });

  it('release() gives the connection back and stops acquisition', async () => {
    const { pool, clients } = fakePool([true]);
    const lease = new RuntimeLease(pool, () => undefined);
    await lease.tryAcquire();
    lease.release();
    expect(lease.held()).toBe(false);
    expect(clients[0]?.release).toHaveBeenCalledOnce();
    await expect(lease.acquire()).rejects.toThrow(/stopped/);
  });
});
