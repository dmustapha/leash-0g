import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { PrivateKey } from 'eciesjs';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { buildTestApp, testSettings, ownerAuth, type TestApp } from '../helpers/app.js';
import { reserveCreate, releaseReservation, sweepStaleReservations } from '../../src/store/reservations.js';
import { createLink } from '../../src/coordination/store.js';
import { CoordinationError } from '../../src/coordination/coordinator.js';
import { getAgentById } from '../../src/store/agents.js';

/**
 * P3C-1 (spec §2a P1): the create quota/rate check and the reservation insert
 * are serialized per owner — a parallel burst can no longer all pass at t=0
 * while the slow on-chain deploys are in flight. Same discipline on the
 * delegation channel throttles.
 */

let db: TestDb;

// trace_records is append-only (007 trigger) so rows can never be cleaned up —
// each test isolates via its OWN owner address (quota/rate/links are all
// owner- or link-scoped).
let ownerCounter = 0;
function uniqueOwner(): string {
  return '0x7e' + String(ownerCounter++).padStart(4, '0') + 'ab'.repeat(17);
}
const auditKey = new PrivateKey();

function createBody(name: string): Record<string, unknown> {
  return {
    name,
    auditPubKey: auditKey.publicKey.toHex(),
    policy: {
      perTransferCapWei: '10000000000000000',
      windowCapWei: '30000000000000000',
      windowSeconds: 3600,
      expiresAt: Math.floor(Date.now() / 1000) + 86_400,
    },
    allowlist: ['0x' + '9c'.repeat(20)],
    goal: {
      beneficiary: '0x' + '9c'.repeat(20),
      targetBalanceWei: '50000000000000000',
      topUpWei: '5000000000000000',
    },
  };
}

/** Make the fake deploy slow so agent rows commit long after the burst hits the guard. */
function slowDeploy(t: TestApp, delayMs: number): void {
  const original = t.chain.deployAndRegister.bind(t.chain);
  t.chain.deployAndRegister = async (input) => {
    await new Promise((r) => setTimeout(r, delayMs));
    return original(input);
  };
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

describe('P3C-1 create burst — quota', () => {
  it('N=8 parallel creates at quota 2 → exactly 2 succeed, the rest 403 quota_exceeded', async () => {
    const owner = uniqueOwner();
    const t = buildTestApp(db.pool, { settings: testSettings({ createQuotaPerOwner: 2 }) });
    slowDeploy(t, 150);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        request(t.app).post('/api/agents').set('authorization', ownerAuth(owner)).send(createBody(`burst-${i}`)),
      ),
    );
    const created = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status === 403);
    expect(created).toHaveLength(2);
    expect(rejected).toHaveLength(6);
    for (const r of rejected) expect(r.body.error).toBe('quota_exceeded');
    // Exactly the admitted creates reached the chain (deploy gas is the drained resource).
    const rows = await db.pool.query<{ n: string }>(`SELECT count(*) AS n FROM agents WHERE owner_addr = $1`, [owner.toLowerCase()]);
    expect(Number(rows.rows[0]?.n)).toBe(2);
  });

  it('quota still counts revoked rows (C-1 semantics preserved through the guard)', async () => {
    const owner = uniqueOwner();
    const t = buildTestApp(db.pool, { settings: testSettings({ createQuotaPerOwner: 1 }) });
    await seedAgent(db.pool, { ownerAddr: owner, status: 'revoked' });
    const res = await request(t.app).post('/api/agents').set('authorization', ownerAuth(owner)).send(createBody('x'));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('quota_exceeded');
  });
});

describe('P3C-1 create burst — rate', () => {
  it('N=8 parallel creates at rate 2/h (quota ample) → exactly 2 succeed, the rest 429 + Retry-After', async () => {
    const owner = uniqueOwner();
    const t = buildTestApp(db.pool, { settings: testSettings({ createRatePerHour: 2 }) });
    slowDeploy(t, 150);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        request(t.app).post('/api/agents').set('authorization', ownerAuth(owner)).send(createBody(`rate-${i}`)),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    const limited = results.filter((r) => r.status === 429);
    expect(limited).toHaveLength(6);
    for (const r of limited) {
      expect(r.body.error).toBe('rate_limited');
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    }
  });

  it('rate counts in-flight reservations before any agent row exists', async () => {
    const owner = uniqueOwner();
    const bounds = { quotaPerOwner: 100, ratePerHour: 1, reservationTtlMs: 120_000 };
    const first = await reserveCreate(db.pool, owner, bounds);
    expect(first.ok).toBe(true);
    // No agents row committed — the live reservation alone must trip the rate.
    const second = await reserveCreate(db.pool, owner, bounds);
    expect(second).toMatchObject({ ok: false, reason: 'rate_limited' });
    if (first.ok) await releaseReservation(db.pool, first.reservationId);
  });
});

describe('P3C-1 reservation lifecycle', () => {
  it('a failed deploy releases the reservation — quota/rate are not burned', async () => {
    const owner = uniqueOwner();
    const t = buildTestApp(db.pool, { settings: testSettings({ createQuotaPerOwner: 1, createRatePerHour: 1 }) });
    const original = t.chain.deployAndRegister.bind(t.chain);
    t.chain.deployAndRegister = async () => {
      throw new Error('deploy reverted');
    };
    const failed = await request(t.app)
      .post('/api/agents')
      .set('authorization', ownerAuth(owner))
      .send(createBody('fails'));
    expect(failed.status).toBe(500);
    const live = await db.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM create_reservations WHERE owner_addr = $1 AND released_at IS NULL`,
      [owner.toLowerCase()],
    );
    expect(Number(live.rows[0]?.n)).toBe(0);
    // The slot is free again: the retry succeeds within the same quota/rate.
    t.chain.deployAndRegister = original;
    const retry = await request(t.app)
      .post('/api/agents')
      .set('authorization', ownerAuth(owner))
      .send(createBody('retries'));
    expect(retry.status).toBe(201);
  });

  it('a successful create releases its reservation (the agent row carries the count)', async () => {
    const owner = uniqueOwner();
    const t = buildTestApp(db.pool);
    const res = await request(t.app).post('/api/agents').set('authorization', ownerAuth(owner)).send(createBody('ok'));
    expect(res.status).toBe(201);
    const live = await db.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM create_reservations WHERE owner_addr = $1 AND released_at IS NULL`,
      [owner.toLowerCase()],
    );
    expect(Number(live.rows[0]?.n)).toBe(0);
  });

  it('a TTL-dead reservation stops counting even before the sweep, and the sweep releases it', async () => {
    const owner = uniqueOwner();
    const bounds = { quotaPerOwner: 1, ratePerHour: 1, reservationTtlMs: 120_000 };
    const r = await reserveCreate(db.pool, owner, bounds);
    expect(r.ok).toBe(true);
    // Age it past the TTL — the create that made it evidently crashed.
    if (!r.ok) throw new Error('expected reservation');
    await db.pool.query(`UPDATE create_reservations SET created_at = now() - interval '10 minutes' WHERE id = $1`, [
      r.reservationId,
    ]);
    const after = await reserveCreate(db.pool, owner, bounds);
    expect(after.ok).toBe(true); // dead row ignored by quota AND rate
    if (after.ok) await releaseReservation(db.pool, after.reservationId);
    const swept = await sweepStaleReservations(db.pool, 120_000);
    expect(swept).toBe(1); // only the aged row; the released one is already closed
    const live = await db.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM create_reservations WHERE released_at IS NULL`,
    );
    expect(Number(live.rows[0]?.n)).toBe(0);
  });

  it('releaseReservation is idempotent', async () => {
    const owner = uniqueOwner();
    const r = await reserveCreate(db.pool, owner, { quotaPerOwner: 5, ratePerHour: 5, reservationTtlMs: 120_000 });
    if (!r.ok) throw new Error('expected reservation');
    await releaseReservation(db.pool, r.reservationId);
    await releaseReservation(db.pool, r.reservationId); // second call: no throw, no change
    const row = await db.pool.query<{ released_at: Date | null }>(
      `SELECT released_at FROM create_reservations WHERE id = $1`,
      [r.reservationId],
    );
    expect(row.rows[0]?.released_at).not.toBeNull();
  });
});

describe('P3C-1 revoke lane under burst', () => {
  it('a guardian revoke completes while a slow create burst is in flight', async () => {
    const owner = uniqueOwner();
    const t = buildTestApp(db.pool, { settings: testSettings({ createQuotaPerOwner: 4 }) });
    const victim = await seedAgent(db.pool, { ownerAddr: owner, name: 'victim' });
    slowDeploy(t, 3000);
    let burstCompleted = 0;
    const burst = Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        request(t.app)
          .post('/api/agents')
          .set('authorization', ownerAuth(owner))
          .send(createBody(`lane-${i}`))
          .then((r) => {
            burstCompleted += 1;
            return r;
          }),
      ),
    );
    // Mid-burst: the revoke must not queue behind the pending creates — it
    // resolves while every deploy is still sleeping (0 creates completed).
    await new Promise((r) => setTimeout(r, 50));
    const revoke = await request(t.app).post(`/api/agents/${victim}/revoke`).set('authorization', ownerAuth(owner));
    expect(revoke.status).toBe(200);
    expect(burstCompleted).toBe(0);
    const agent = await getAgentById(db.pool, victim);
    expect(agent?.status).toBe('revoked');
    await burst;
  });
});

describe('P3C-1 delegation channel throttle race', () => {
  it('8 parallel issuances at maxPending 3 → exactly 3 envelopes admitted', async () => {
    const owner = uniqueOwner();
    const t = buildTestApp(db.pool);
    const fromId = await seedAgent(db.pool, { ownerAddr: owner, name: 'issuer' });
    const toId = await seedAgent(db.pool, { ownerAddr: owner, name: 'receiver' });
    const link = await createLink(db.pool, { ownerAddr: owner, fromAgentId: fromId, toAgentId: toId, mode: 'auto' });
    const from = await getAgentById(db.pool, fromId);
    if (!from) throw new Error('issuer missing');
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        t.coordinator.issueDelegation({ fromAgent: from, kind: 'noop', payload: { i } }),
      ),
    );
    const admitted = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(admitted).toHaveLength(3);
    expect(rejected).toHaveLength(5);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(CoordinationError);
      expect((r.reason as CoordinationError).reason).toBe('delegation_max_pending');
    }
    const rows = await db.pool.query<{ n: string }>(`SELECT count(*) AS n FROM delegations WHERE link_id = $1`, [
      link.id,
    ]);
    expect(Number(rows.rows[0]?.n)).toBe(3);
  });

  it('parallel issuances beyond the hourly rate are bounded (rate half of the same guard)', async () => {
    const owner = uniqueOwner();
    const t = buildTestApp(db.pool, {
      settings: testSettings({ delegationRatePerLinkPerHour: 2, delegationMaxPendingPerLink: 100 }),
    });
    const fromId = await seedAgent(db.pool, { ownerAddr: owner, name: 'issuer2' });
    const toId = await seedAgent(db.pool, { ownerAddr: owner, name: 'receiver2' });
    const link = await createLink(db.pool, { ownerAddr: owner, fromAgentId: fromId, toAgentId: toId, mode: 'auto' });
    const from = await getAgentById(db.pool, fromId);
    if (!from) throw new Error('issuer missing');
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        t.coordinator.issueDelegation({ fromAgent: from, kind: 'noop', payload: { i } }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    const rows = await db.pool.query<{ n: string }>(`SELECT count(*) AS n FROM delegations WHERE link_id = $1`, [
      link.id,
    ]);
    expect(Number(rows.rows[0]?.n)).toBe(2);
  });
});

describe('P3C-5 fleet-list balance cache', () => {
  it('GET /api/agents serves balances from a short-TTL cache (no RPC amplification)', async () => {
    const owner = uniqueOwner();
    const t = buildTestApp(db.pool);
    const agentId = await seedAgent(db.pool, { ownerAddr: owner, name: 'cached' });
    void agentId;
    let reads = 0;
    const originalGetBalance = t.chain.getBalance.bind(t.chain);
    t.chain.getBalance = async (addr: string) => {
      reads += 1;
      return originalGetBalance(addr);
    };
    const first = await request(t.app).get('/api/agents').set('authorization', ownerAuth(owner));
    expect(first.status).toBe(200);
    const afterFirst = reads;
    expect(afterFirst).toBeGreaterThan(0);
    // Repeated list calls within the TTL never touch the RPC again.
    for (let i = 0; i < 5; i++) {
      const res = await request(t.app).get('/api/agents').set('authorization', ownerAuth(owner));
      expect(res.status).toBe(200);
    }
    expect(reads).toBe(afterFirst);
  });

  it('the cache expires after the TTL (fresh read)', async () => {
    const owner = uniqueOwner();
    const t = buildTestApp(db.pool, { settings: testSettings({ balanceCacheTtlMs: 50 }) });
    await seedAgent(db.pool, { ownerAddr: owner, name: 'ttl' });
    let reads = 0;
    const originalGetBalance = t.chain.getBalance.bind(t.chain);
    t.chain.getBalance = async (addr: string) => {
      reads += 1;
      return originalGetBalance(addr);
    };
    await request(t.app).get('/api/agents').set('authorization', ownerAuth(owner));
    const afterFirst = reads;
    await new Promise((r) => setTimeout(r, 80));
    await request(t.app).get('/api/agents').set('authorization', ownerAuth(owner));
    expect(reads).toBeGreaterThan(afterFirst);
  });
});
