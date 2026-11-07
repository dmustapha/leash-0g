import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import nock from 'nock';
import { PrivateKey } from 'eciesjs';
import { createTestDb, type TestDb } from '../helpers/db.js';
import { buildTestApp, testSettings, ownerAuth, UPSTREAM, TEST_KEYRING, FAKE_GUARDIAN_ADDR, type TestApp } from '../helpers/app.js';
import { listTraces } from '../../src/trace/trace-store.js';
import { decryptSecret } from '../../src/crypto/keycrypt.js';

let db: TestDb;
let t: TestApp;

const OWNER = '0x' + '5a'.repeat(20);
const OTHER_OWNER = '0x' + '6b'.repeat(20);
const auditKey = new PrivateKey();

const CREATE_BODY = {
  name: 'treasury-agent',
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
  encryptedAuditKey: 'blob-v1:opaque-client-side-encrypted-audit-key',
};

beforeAll(async () => {
  db = await createTestDb();
  nock.disableNetConnect();
  nock.enableNetConnect(/127\.0\.0\.1|localhost|neon\.tech/);
});

beforeEach(() => {
  t = buildTestApp(db.pool);
});

afterEach(() => nock.cleanAll());

afterAll(async () => {
  nock.enableNetConnect();
  await db.drop();
});

async function createAgent(): Promise<{ id: string; token: string; accountAddr: string }> {
  const res = await request(t.app).post('/api/agents').set('authorization', ownerAuth(OWNER)).send(CREATE_BODY);
  expect(res.status).toBe(201);
  return { id: res.body.agentId, token: res.body.gatewayToken, accountAddr: res.body.accountAddr };
}

describe('owner auth', () => {
  it('401 without Privy auth on every owner route', async () => {
    for (const [method, path] of [
      ['post', '/api/agents'],
      ['get', '/api/agents/x'],
      ['get', '/api/agents/x/traces'],
      ['get', '/api/agents/x/audit'],
      ['post', '/api/agents/x/rotate'],
      ['post', '/api/agents/x/revoke'],
      ['post', '/api/agents/x/start'],
      ['post', '/api/agents/x/stop'],
      ['post', '/api/approvals/x'],
    ] as const) {
      const res = await (method === 'post' ? request(t.app).post(path) : request(t.app).get(path)).send({});
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it("404 when the authed wallet does not match the agent's owner_addr", async () => {
    const a = await createAgent();
    const res = await request(t.app).get(`/api/agents/${a.id}`).set('authorization', ownerAuth(OTHER_OWNER));
    expect(res.status).toBe(404);
  });
});

describe('POST /api/agents', () => {
  it('creates the agent: deploys, registers, issues token ONCE, encrypts session key, funds gas dust', async () => {
    const res = await request(t.app).post('/api/agents').set('authorization', ownerAuth(OWNER)).send(CREATE_BODY);
    expect(res.status).toBe(201);
    expect(res.body.gatewayToken).toMatch(/^leash_/);
    expect(res.body.agentId).toBeDefined();
    expect(res.body.accountAddr).toMatch(/^0x/);
    expect(res.body.sessionKeyAddr).toMatch(/^0x/);
    expect(res.body.chainAgentId).toBeDefined();
    expect(res.body.txHashes).toHaveLength(2);

    const row = await db.pool.query<{
      owner_addr: string;
      session_key_enc: string;
      session_key_addr: string;
      token_hash: string;
      audit_pubkey: string;
      status: string;
      encrypted_audit_key: string;
    }>(
      `SELECT owner_addr, session_key_enc, session_key_addr, token_hash, audit_pubkey, status, encrypted_audit_key
       FROM agents WHERE id = $1`,
      [res.body.agentId],
    );
    const r = row.rows[0];
    if (!r) throw new Error('agent row missing');
    expect(r.owner_addr).toBe(OWNER.toLowerCase());
    expect(r.status).toBe('active');
    expect(r.token_hash.startsWith('$argon2id$')).toBe(true);
    // encrypted audit-key blob stored blind, byte-for-byte
    expect(r.encrypted_audit_key).toBe(CREATE_BODY.encryptedAuditKey);
    // stored session key is encrypted, decryptable with the KEK, matches the address
    const pk = decryptSecret(r.session_key_enc, TEST_KEYRING);
    expect(pk).toMatch(/^0x[0-9a-f]{64}$/);
    // gas dust was funded to the session key
    expect(t.chain.funded.some((f) => f.addr.toLowerCase() === String(r.session_key_addr).toLowerCase())).toBe(true);
  });

  it('validates the body', async () => {
    const res = await request(t.app)
      .post('/api/agents')
      .set('authorization', ownerAuth(OWNER))
      .send({ name: '' });
    expect(res.status).toBe(400);
  });

  it('rejects goal.topUpWei above policy.perTransferCapWei (cross-field refine)', async () => {
    const res = await request(t.app)
      .post('/api/agents')
      .set('authorization', ownerAuth(OWNER))
      .send({
        ...CREATE_BODY,
        goal: { ...CREATE_BODY.goal, topUpWei: '20000000000000000' }, // > 0.01 cap
      });
    expect(res.status).toBe(400);
  });

  it('stores a runtime copy of the gateway token, decryptable with the KEK', async () => {
    const res = await request(t.app).post('/api/agents').set('authorization', ownerAuth(OWNER)).send(CREATE_BODY);
    expect(res.status).toBe(201);
    const row = await db.pool.query(`SELECT gateway_token_enc FROM agents WHERE id = $1`, [res.body.agentId]);
    expect(decryptSecret(row.rows[0].gateway_token_enc, TEST_KEYRING)).toBe(res.body.gatewayToken);
  });
});

// Phase-4 ACP role create-validation (spec §4). The API is the enforcement
// boundary — a direct caller must not mint a mis-configured role.
describe('POST /api/agents — Phase-4 ACP roles', () => {
  const TOKEN = '0x' + 'a5'.repeat(20);
  const RECIPIENT = '0x' + '9c'.repeat(20);
  const provId = '22222222-2222-4222-8222-222222222222';
  const evalId = '33333333-3333-4333-8333-333333333333';

  function requesterBody(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      ...CREATE_BODY,
      name: 'requester',
      allowlist: [RECIPIENT],
      goal: {
        type: 'requester',
        jobSpecSource: 'job-1',
        providerAgentId: provId,
        evaluatorAgentId: evalId,
        feeToken: TOKEN,
        feeRecipient: RECIPIENT,
        feeCapPerJobWei: '100000000',
      },
      tokenConfig: { settlementToken: TOKEN, perTransferCapTokenWei: '100000000', windowCapTokenWei: '250000000' },
      ...over,
    };
  }

  async function post(body: Record<string, unknown>) {
    return request(t.app).post('/api/agents').set('authorization', ownerAuth('0x' + 'c1'.repeat(20))).send(body);
  }

  it('creates a valid requester (token-capable)', async () => {
    const res = await post(requesterBody());
    expect(res.status).toBe(201);
  });

  it('rejects a requester with no tokenConfig', async () => {
    const b = requesterBody();
    delete b['tokenConfig'];
    expect((await post(b)).status).toBe(400);
  });

  it('rejects feeToken != settlementToken', async () => {
    const res = await post(requesterBody({ goal: { ...(requesterBody().goal as object), feeToken: '0x' + 'b6'.repeat(20) } }));
    expect(res.status).toBe(400);
  });

  it('rejects feeCapPerJob above the per-token per-transfer cap', async () => {
    const res = await post(requesterBody({ goal: { ...(requesterBody().goal as object), feeCapPerJobWei: '999000000' } }));
    expect(res.status).toBe(400);
  });

  it('rejects feeRecipient not in the allowlist', async () => {
    const res = await post(requesterBody({ allowlist: ['0x' + 'de'.repeat(20)] }));
    expect(res.status).toBe(400);
  });

  it('rejects tokenConfig on a non-requester goal', async () => {
    const res = await post({ ...requesterBody(), goal: { type: 'provider', serviceSpec: 'x' } });
    expect(res.status).toBe(400);
  });

  it('creates a spend-incapable provider (zero caps, empty allowlist)', async () => {
    const res = await post({
      ...CREATE_BODY,
      name: 'provider',
      allowlist: [],
      policy: { ...CREATE_BODY.policy, perTransferCapWei: '0', windowCapWei: '0' },
      goal: { type: 'provider', serviceSpec: 'probability forecasting' },
      tokenConfig: undefined,
    });
    expect(res.status).toBe(201);
  });

  it('rejects a provider with non-zero native caps', async () => {
    const res = await post({
      ...CREATE_BODY,
      name: 'provider',
      allowlist: [],
      goal: { type: 'provider', serviceSpec: 'x' },
      tokenConfig: undefined,
    });
    expect(res.status).toBe(400);
  });

  it('creates a spend-incapable evaluator', async () => {
    const res = await post({
      ...CREATE_BODY,
      name: 'evaluator',
      allowlist: [],
      policy: { ...CREATE_BODY.policy, perTransferCapWei: '0', windowCapWei: '0' },
      goal: { type: 'evaluator', rubricRef: 'rubric-1' },
      tokenConfig: undefined,
    });
    expect(res.status).toBe(201);
  });
});

describe('agent lifecycle routes', () => {
  it('GET /api/agents/:id returns the FE AgentDetail shape incl. encryptedAuditKey', async () => {
    const a = await createAgent();
    const res = await request(t.app).get(`/api/agents/${a.id}`).set('authorization', ownerAuth(OWNER));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('paused'); // active in DB but runtime not started
    expect(res.body.policy.perTransferCapWei).toBe('10000000000000000');
    expect(res.body.policy.windowCapWei).toBe('30000000000000000');
    expect(res.body.accountBalance).toBeDefined();
    expect(res.body.sessionExpiry).toBe(res.body.policy.expiresAt);
    expect(String(res.body.addresses.account).toLowerCase()).toBe(a.accountAddr.toLowerCase());
    expect(res.body.addresses.owner).toBe(OWNER.toLowerCase());
    expect(res.body.encryptedAuditKey).toBe(CREATE_BODY.encryptedAuditKey);
    // RH2 (B1): publicAgent surfaces the account grammar version so the FE owner-arming
    // panels pick the V5-vs-V4 encoding ABI. A default create is V4.
    expect(res.body.agent.accountVersion).toBe(4);

    await request(t.app).post(`/api/agents/${a.id}/start`).set('authorization', ownerAuth(OWNER));
    const running = await request(t.app).get(`/api/agents/${a.id}`).set('authorization', ownerAuth(OWNER));
    expect(running.body.status).toBe('running');
  });

  it('rotate invalidates the old gateway token and returns a new one once', async () => {
    const a = await createAgent();
    nock(UPSTREAM).post('/v1/chat/completions').times(2).reply(200, { choices: [{ message: { content: 'x' } }] });
    const before = await request(t.app)
      .post('/v1/chat/completions')
      .set('authorization', `Bearer ${a.token}`)
      .send({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    expect(before.status).toBe(200);

    const rot = await request(t.app).post(`/api/agents/${a.id}/rotate`).set('authorization', ownerAuth(OWNER));
    expect(rot.status).toBe(200);
    expect(rot.body.gatewayToken).toMatch(/^leash_/);
    expect(rot.body.gatewayToken).not.toBe(a.token);

    const old = await request(t.app)
      .post('/v1/chat/completions')
      .set('authorization', `Bearer ${a.token}`)
      .send({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    expect(old.status).toBe(401);

    const fresh = await request(t.app)
      .post('/v1/chat/completions')
      .set('authorization', `Bearer ${rot.body.gatewayToken}`)
      .send({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    expect(fresh.status).toBe(200);
  });

  it('start/stop drive the runtime manager', async () => {
    const a = await createAgent();
    const start = await request(t.app).post(`/api/agents/${a.id}/start`).set('authorization', ownerAuth(OWNER));
    expect(start.status).toBe(200);
    expect(t.runtime.isRunning(a.id)).toBe(true);
    const stop = await request(t.app).post(`/api/agents/${a.id}/stop`).set('authorization', ownerAuth(OWNER));
    expect(stop.status).toBe(200);
    expect(t.runtime.isRunning(a.id)).toBe(false);
  });

  it('GET traces pages with cursor and requires the right owner', async () => {
    const a = await createAgent();
    nock(UPSTREAM).post('/v1/chat/completions').times(3).reply(200, { choices: [{ message: { content: 'x' } }] });
    for (let i = 0; i < 3; i++) {
      await request(t.app)
        .post('/v1/chat/completions')
        .set('authorization', `Bearer ${a.token}`)
        .send({ model: 'm', messages: [{ role: 'user', content: `q${i}` }] });
    }
    const page = await request(t.app)
      .get(`/api/agents/${a.id}/traces?limit=2`)
      .set('authorization', ownerAuth(OWNER));
    expect(page.status).toBe(200);
    expect(page.body.records).toHaveLength(2);
    const page2 = await request(t.app)
      .get(`/api/agents/${a.id}/traces?cursor=${page.body.nextCursor}&limit=2`)
      .set('authorization', ownerAuth(OWNER));
    expect(page2.body.records).toHaveLength(1);
    expect(page2.body.chainVerified).toBe(true);

    const denied = await request(t.app)
      .get(`/api/agents/${a.id}/traces`)
      .set('authorization', ownerAuth(OTHER_OWNER));
    expect(denied.status).toBe(404);
  });

  it('GET audit lists batches as a bare array with ciphertext URLs', async () => {
    const a = await createAgent();
    const empty = await request(t.app).get(`/api/agents/${a.id}/audit`).set('authorization', ownerAuth(OWNER));
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual([]);

    const root = '0x' + 'ab'.repeat(32);
    await db.pool.query(
      `INSERT INTO audit_batches (agent_id, seq_from, seq_to, merkle_root, storage_tx) VALUES ($1,0,4,$2,$3)`,
      [a.id, root, '0x' + 'cd'.repeat(32)],
    );
    const res = await request(t.app).get(`/api/agents/${a.id}/audit`).set('authorization', ownerAuth(OWNER));
    expect(res.body).toHaveLength(1);
    expect(res.body[0].seqFrom).toBe(0);
    expect(res.body[0].seqTo).toBe(4);
    expect(res.body[0].ciphertextUrl).toBe(`https://indexer.leash-test.local/file?root=${root}`);
  });

  it('healthz is public and detail-free', async () => {
    const res = await request(t.app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe('revoke fan-out', () => {
  it('POST revoke: fires guardian revoke on-chain, marks DB, halts runtime, gateway 403s thereafter', async () => {
    const a = await createAgent();
    await request(t.app).post(`/api/agents/${a.id}/start`).set('authorization', ownerAuth(OWNER));

    const res = await request(t.app).post(`/api/agents/${a.id}/revoke`).set('authorization', ownerAuth(OWNER));
    expect(res.status).toBe(200);
    expect(res.body.txHash).toBeDefined();
    // layer 1: chain revoke fired
    expect(t.chain.revoked).toContain(a.accountAddr.toLowerCase());
    // layer 2: runtime halted
    expect(t.runtime.halted).toContain(a.id);
    expect(t.runtime.isRunning(a.id)).toBe(false);
    // layer 3: DB marked + gateway refuses the token
    const row = await db.pool.query(`SELECT status FROM agents WHERE id = $1`, [a.id]);
    expect(row.rows[0]?.state ?? row.rows[0]?.status).toBe('revoked');
    const gw = await request(t.app)
      .post('/v1/chat/completions')
      .set('authorization', `Bearer ${a.token}`)
      .send({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    expect(gw.status).toBe(403);
    // revoke is traced
    const traces = await listTraces(db.pool, a.id);
    expect(traces.some((r) => r.kind === 'revoke')).toBe(true);
  });

  it('observed on-chain Revoked event triggers the same fan-out', async () => {
    const a = await createAgent();
    await request(t.app).post(`/api/agents/${a.id}/start`).set('authorization', ownerAuth(OWNER));
    const { applyRevokeFanout } = await import('../../src/agents/revoke-fanout.js');
    await applyRevokeFanout(
      { pool: db.pool, hub: t.hub, runtime: t.runtime },
      a.id,
      'onchain-event',
    );
    const row = await db.pool.query(`SELECT status FROM agents WHERE id = $1`, [a.id]);
    expect(row.rows[0]?.status).toBe('revoked');
    expect(t.runtime.halted).toContain(a.id);
    const gw = await request(t.app)
      .post('/v1/chat/completions')
      .set('authorization', `Bearer ${a.token}`)
      .send({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    expect(gw.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// C-1: create quota / rate limit / allowlist cap + guardian lane recording
// C-2: reverted guardian revoke is never reported ok
// ---------------------------------------------------------------------------
describe('C-1 create hardening', () => {
  it('rejects an allowlist longer than ALLOWLIST_MAX with the spec error shape', async () => {
    const body = {
      ...CREATE_BODY,
      // i+1: index 0 would mint the zero address, which the schema rejects first.
      allowlist: Array.from({ length: 17 }, (_, i) => '0x' + (i + 1).toString(16).padStart(2, '0').repeat(20)),
    };
    const res = await request(t.app).post('/api/agents').set('authorization', ownerAuth(OWNER)).send(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'allowlist_too_long', max: 16 });
  });

  it('rejects more than RULES_MAX gateway rules', async () => {
    const body = {
      ...CREATE_BODY,
      gatewayRules: Array.from({ length: 33 }, (_, i) => ({ action: 'block' as const, match: `rule-${i}` })),
    };
    const res = await request(t.app).post('/api/agents').set('authorization', ownerAuth(OWNER)).send(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'too_many_rules', max: 32 });
  });

  it('enforces the per-owner quota — revoked rows still count (no quota refill)', async () => {
    const quotaOwner = '0x' + '7c'.repeat(20);
    const freshOwner = '0x' + '7d'.repeat(20);
    t = buildTestApp(db.pool, { settings: testSettings({ createQuotaPerOwner: 3, createRatePerHour: 100 }) });
    const mk = () =>
      request(t.app).post('/api/agents').set('authorization', ownerAuth(quotaOwner)).send(CREATE_BODY);
    const created: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await mk();
      expect(r.status).toBe(201);
      created.push(r.body.agentId);
    }
    // Revoke one — the quota must NOT refill.
    const rev = await request(t.app)
      .post(`/api/agents/${created[0]}/revoke`)
      .set('authorization', ownerAuth(quotaOwner))
      .send({});
    expect(rev.status).toBe(200);
    const res = await mk();
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'quota_exceeded', limit: 3 });
    // A different owner is unaffected (per-owner scoping).
    const other = await request(t.app)
      .post('/api/agents')
      .set('authorization', ownerAuth(freshOwner))
      .send(CREATE_BODY);
    expect(other.status).toBe(201);
  });

  it('rate-limits creates per owner with a Retry-After hint', async () => {
    const rateOwner = '0x' + '7e'.repeat(20);
    t = buildTestApp(db.pool, { settings: testSettings({ createRatePerHour: 2, createQuotaPerOwner: 100 }) });
    const mk = () =>
      request(t.app).post('/api/agents').set('authorization', ownerAuth(rateOwner)).send(CREATE_BODY);
    expect((await mk()).status).toBe(201);
    expect((await mk()).status).toBe(201);
    const res = await mk();
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('rate_limited');
    expect(res.body.retryAfter).toBeGreaterThan(0);
    expect(res.body.retryAfter).toBeLessThanOrEqual(3600);
    expect(Number(res.headers['retry-after'])).toBe(res.body.retryAfter);
  });

  it('records the guardian address the account was created with (guardian lane, S5/S7)', async () => {
    const a = await createAgent();
    const row = await db.pool.query(`SELECT guardian_addr FROM agents WHERE id = $1`, [a.id]);
    expect(row.rows[0].guardian_addr).toBe(FAKE_GUARDIAN_ADDR.toLowerCase());
    // Revoke passes the stored guardian to the chain layer for lane selection.
    const rev = await request(t.app)
      .post(`/api/agents/${a.id}/revoke`)
      .set('authorization', ownerAuth(OWNER))
      .send({});
    expect(rev.status).toBe(200);
    expect(t.chain.revokeGuardians).toEqual([FAKE_GUARDIAN_ADDR.toLowerCase()]);
  });
});

// ---------------------------------------------------------------------------
// P1-BE coverage gaps (tests-only, green-on-add — behavior already correct):
//   G1 SSE owner-stream route  GET /api/agents/:id/stream
//   G2 live per-request chain read on  GET /api/agents/:id (no cache)
//   G3 owner /api 64KB json body cap -> 413
// ---------------------------------------------------------------------------

describe('G1 — SSE owner-stream route GET /api/agents/:id/stream', () => {
  it('(a) a FOREIGN owner gets 404 (requireOwnedAgent fails closed, no stream opened)', async () => {
    const a = await createAgent();
    const res = await request(t.app).get(`/api/agents/${a.id}/stream`).set('authorization', ownerAuth(OTHER_OWNER));
    expect(res.status).toBe(404);
    // The 404 is the load-bearing guard: requireOwnedAgent (owner-routes.ts:1190)
    // returns before hub.attach (:1194) is ever reached. The hub counts below are
    // a corroborating sanity check (0 either way), NOT an independent proof of the
    // ordering — the status-404 assertion carries the weight.
    expect(t.hub.clientCount(a.id)).toBe(0);
    expect(t.hub.ownerConnections(OTHER_OWNER)).toBe(0);
  });

  it('(b) the OWNER gets an SSE head: 200 + text/event-stream (socket destroyed, never hangs)', async () => {
    const a = await createAgent();
    // Long-lived stream: drive it over a real listener and abort right after the
    // head so the open connection cannot hang the test.
    const server = http.createServer(t.ownerApp).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as AddressInfo;
    try {
      const { status, contentType } = await new Promise<{ status: number; contentType: string | undefined }>(
        (resolve, reject) => {
          const req = http.get(
            {
              host: '127.0.0.1',
              port,
              path: `/api/agents/${a.id}/stream`,
              headers: { authorization: ownerAuth(OWNER) },
            },
            (res) => {
              const result = { status: res.statusCode ?? 0, contentType: res.headers['content-type'] };
              res.destroy(); // tear down the long-lived stream immediately
              req.destroy();
              resolve(result);
            },
          );
          req.on('error', (err) => {
            // destroy() may surface as an aborted error after we already resolved.
            if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err);
          });
        },
      );
      expect(status).toBe(200);
      expect(contentType).toContain('text/event-stream');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // (c) The P4C-1 per-owner connection cap (429 before the SSE head) is covered
  // by the sse-hub unit tests; a route-level cap test here is fiddly (needs many
  // concurrent held-open sockets) and flaky, so it is intentionally omitted.
});

describe('G2 — GET /api/agents/:id reads policy+balance live per request (no cache)', () => {
  it('a mutation of the mock chain between two GETs is reflected in the second response', async () => {
    const a = await createAgent();

    const first = await request(t.app).get(`/api/agents/${a.id}`).set('authorization', ownerAuth(OWNER));
    expect(first.status).toBe(200);
    expect(first.body.policy.perTransferCapWei).toBe('10000000000000000');
    expect(first.body.accountBalance).toBe('0');

    // Mutate the live chain view AFTER the first read. A cached read would still
    // return the old values; a live per-request read must pick these up.
    t.chain.policyView = { ...t.chain.policyView, perTransferCap: 42n };
    t.chain.balances.set(a.accountAddr.toLowerCase(), 777n);

    const second = await request(t.app).get(`/api/agents/${a.id}`).set('authorization', ownerAuth(OWNER));
    expect(second.status).toBe(200);
    expect(second.body.policy.perTransferCapWei).toBe('42');
    expect(second.body.accountBalance).toBe('777');
  });
});

describe('G3 — owner /api json body cap (64KB -> 413)', () => {
  it('a >64KB body to an owner route returns 413', async () => {
    const a = await createAgent();
    // One valid rule padded past the 64KB owner-side json limit (owner-routes.ts:605).
    // The cap fires in the body parser before any route logic runs.
    const res = await request(t.app)
      .patch(`/api/agents/${a.id}/rules`)
      .set('authorization', ownerAuth(OWNER))
      .send({ rules: [{ action: 'block', match: 'x'.repeat(70 * 1024) }] });
    expect(res.status).toBe(413);
  });
});

describe('C-2 revoke receipt guard', () => {
  it('a failed guardian revoke: not ok, DB NOT revoked, runtime halted, error traced, FE steer', async () => {
    const a = await createAgent();
    await request(t.app).post(`/api/agents/${a.id}/start`).set('authorization', ownerAuth(OWNER)).send({});
    t.chain.revokeError = new Error('guardian revoke tx reverted on-chain: 0xdead');

    const res = await request(t.app)
      .post(`/api/agents/${a.id}/revoke`)
      .set('authorization', ownerAuth(OWNER))
      .send({});
    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('guardian_revoke_failed');
    expect(res.body.ownerRevokeFallback.accountAddr).toBe(a.accountAddr);

    // DB must still say active — the hard boundary is still armed.
    const row = await db.pool.query(`SELECT status FROM agents WHERE id = $1`, [a.id]);
    expect(row.rows[0].status).toBe('active');
    // Runtime halted anyway (defense-in-depth).
    expect(t.runtime.halted).toContain(a.id);
    // Failure is chain-visible.
    const traces = await listTraces(db.pool, a.id, { afterSeq: -1, limit: 50 });
    const errRec = traces.find((r) => r.kind === 'error');
    const detail = errRec?.detail as { summary?: string } | undefined;
    expect(detail?.summary).toContain('guardian revoke failed');
  });
});

describe('beta 3b — GET /api/agents/:id carries the goal asset for a token agent', () => {
  const TOKEN = '0x' + 'ec'.repeat(20);
  it('token goal: goalAsset has balance, meta and on-chain token limits; a native agent has none', async () => {
    const native = await createAgent();
    const nativeRes = await request(t.app).get(`/api/agents/${native.id}`).set('authorization', ownerAuth(OWNER));
    expect(nativeRes.body.goalAsset).toBeUndefined();

    const a = await createAgent();
    await db.pool.query(`UPDATE agents SET goal = $2 WHERE id = $1`, [a.id, JSON.stringify({ token: TOKEN, beneficiary: '0x' + '9c'.repeat(20), targetBalanceWei: '10', topUpWei: '1' })]);
    const chain = t.chain as unknown as { getErc20Balance: () => Promise<bigint>; getErc20Meta: () => Promise<{ symbol: string; decimals: number }> };
    chain.getErc20Balance = async () => 3_980_000_000_000_000_000n;
    chain.getErc20Meta = async () => ({ symbol: 'NOVL', decimals: 18 });
    t.chain.policyView = {
      ...t.chain.policyView,
      assets: [{ token: TOKEN, enabled: true, perTransferCap: 10_000_000_000_000_000n, windowCap: 50_000_000_000_000_000n, windowSeconds: 86400, spentInWindow: 0n, windowStart: 0 }],
    };
    const res = await request(t.app).get(`/api/agents/${a.id}`).set('authorization', ownerAuth(OWNER));
    expect(res.status).toBe(200);
    expect(res.body.goalAsset).toEqual({
      token: TOKEN, symbol: 'NOVL', decimals: 18, balanceWei: '3980000000000000000',
      enabled: true, perTransferCapWei: '10000000000000000', windowCapWei: '50000000000000000', windowSeconds: 86400,
    });
  });
});
