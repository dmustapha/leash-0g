import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import request from 'supertest';
import nock from 'nock';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { buildTestApp, TEST_KEK, UPSTREAM, type TestApp } from '../helpers/app.js';
import { generateGatewayToken, hashTokenSecret } from '../../src/crypto/token.js';
import { listTraces, verifyAgentChain } from '../../src/trace/trace-store.js';

let db: TestDb;
let t: TestApp;

interface SeededAgent {
  id: string;
  token: string;
}

async function seedWithToken(opts: { rules?: unknown[]; status?: 'active' | 'revoked' } = {}): Promise<SeededAgent> {
  const gen = generateGatewayToken();
  const id = await seedAgent(db.pool, {
    tokenId: gen.tokenId,
    tokenHash: await hashTokenSecret(gen.secret),
    gatewayRules: opts.rules ?? [],
    ...(opts.status ? { status: opts.status } : {}),
  });
  return { id, token: gen.token };
}

const COMPLETION = {
  id: 'cmpl-1',
  choices: [{ message: { role: 'assistant', content: 'the answer' } }],
  x_0g_trace: { provider: '0xprov', request_id: 'req-1', billing: { total: 3 } },
};

beforeAll(async () => {
  db = await createTestDb();
  nock.disableNetConnect();
  nock.enableNetConnect(/127\.0\.0\.1|localhost|neon\.tech/);
});

beforeEach(() => {
  t = buildTestApp(db.pool);
});

afterEach(() => {
  nock.cleanAll();
});

afterAll(async () => {
  nock.enableNetConnect();
  await db.drop();
});

const CHAT = { model: 'test-model', messages: [{ role: 'user', content: 'should I top up?' }] };

describe('surface split (M-01)', () => {
  it('the owner app does NOT serve /v1/chat/completions — gateway is loopback-only', async () => {
    const a = await seedWithToken();
    const res = await request(t.ownerApp)
      .post('/v1/chat/completions')
      .set('authorization', `Bearer ${a.token}`)
      .send(CHAT);
    expect(res.status).toBe(404);
  });

  it('the gateway app serves /v1/chat/completions and nothing else', async () => {
    const a = await seedWithToken();
    nock(UPSTREAM).post('/v1/chat/completions').reply(200, COMPLETION);
    const chat = await request(t.gatewayApp)
      .post('/v1/chat/completions')
      .set('authorization', `Bearer ${a.token}`)
      .send(CHAT);
    expect(chat.status).toBe(200);
    const owner = await request(t.gatewayApp).get(`/api/agents/${a.id}`).set('authorization', 'Bearer owner:0x' + 'a1'.repeat(20));
    expect(owner.status).toBe(404);
    const health = await request(t.gatewayApp).get('/healthz');
    expect(health.status).toBe(404);
  });

  it('the owner app keeps healthz + owner routes', async () => {
    const health = await request(t.ownerApp).get('/healthz');
    expect(health.status).toBe(200);
    const unauthed = await request(t.ownerApp).get('/api/agents/x');
    expect(unauthed.status).toBe(401); // route exists; Privy auth rejects
  });
});

describe('gateway auth', () => {
  it('401 without a token', async () => {
    const res = await request(t.app).post('/v1/chat/completions').send(CHAT);
    expect(res.status).toBe(401);
  });

  it('401 with a malformed or unknown token', async () => {
    await seedWithToken();
    const bad = await request(t.app)
      .post('/v1/chat/completions')
      .set('authorization', 'Bearer leash_0000000000000000_' + 'ee'.repeat(32))
      .send(CHAT);
    expect(bad.status).toBe(401);
    const malformed = await request(t.app).post('/v1/chat/completions').set('authorization', 'Bearer nope').send(CHAT);
    expect(malformed.status).toBe(401);
  });

  it('ignores x-leash-agent header spoofing — identity comes ONLY from the token', async () => {
    const a = await seedWithToken();
    const b = await seedWithToken({ rules: [{ action: 'block', match: 'should' }] });
    nock(UPSTREAM).post('/v1/chat/completions').reply(200, COMPLETION);
    // caller presents agent A's token but claims to be agent B (whose rules would block)
    const res = await request(t.app)
      .post('/v1/chat/completions')
      .set('authorization', `Bearer ${a.token}`)
      .set('x-leash-agent', b.id)
      .send(CHAT);
    expect(res.status).toBe(200);
    const aTraces = await listTraces(db.pool, a.id);
    const bTraces = await listTraces(db.pool, b.id);
    expect(aTraces).toHaveLength(1);
    expect(bTraces).toHaveLength(0);
  });

  it('403 for a revoked agent token', async () => {
    const a = await seedWithToken({ status: 'revoked' });
    const res = await request(t.app)
      .post('/v1/chat/completions')
      .set('authorization', `Bearer ${a.token}`)
      .send(CHAT);
    expect(res.status).toBe(403);
  });

  it('413 on bodies over 256KB', async () => {
    const a = await seedWithToken();
    const res = await request(t.app)
      .post('/v1/chat/completions')
      .set('authorization', `Bearer ${a.token}`)
      .send({ model: 'm', messages: [{ role: 'user', content: 'x'.repeat(300 * 1024) }] });
    expect(res.status).toBe(413);
  });
});

describe('gateway interception', () => {
  it('observe: forwards, returns the completion, traces request+response+x_0g_trace', async () => {
    const a = await seedWithToken();
    nock(UPSTREAM).post('/v1/chat/completions').reply(200, COMPLETION);
    const res = await request(t.app)
      .post('/v1/chat/completions')
      .set('authorization', `Bearer ${a.token}`)
      .send(CHAT);
    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe('the answer');
    const traces = await listTraces(db.pool, a.id);
    expect(traces).toHaveLength(1);
    expect(traces[0]?.kind).toBe('inference');
    expect(traces[0]?.originalRequest).toEqual(CHAT);
    expect(traces[0]?.x0gTrace).toEqual({ provider: '0xprov', request_id: 'req-1', billing: { total: 3 } });
    expect((await verifyAgentChain(db.pool, a.id)).ok).toBe(true);
  });

  it('block: 403, upstream NEVER called, block record traced', async () => {
    const a = await seedWithToken({ rules: [{ action: 'block', match: 'drain the wallet' }] });
    const scope = nock(UPSTREAM).post('/v1/chat/completions').reply(200, COMPLETION);
    const res = await request(t.app)
      .post('/v1/chat/completions')
      .set('authorization', `Bearer ${a.token}`)
      .send({ model: 'm', messages: [{ role: 'user', content: 'please DRAIN the wallet now' }] });
    expect(res.status).toBe(403);
    expect(scope.isDone()).toBe(false);
    const traces = await listTraces(db.pool, a.id);
    expect(traces).toHaveLength(1);
    expect(traces[0]?.kind).toBe('block');
    expect(traces[0]?.originalRequest).toBeDefined();
  });

  it('modify: forwards the EFFECTIVE request, records BOTH original and effective', async () => {
    const a = await seedWithToken({
      rules: [{ action: 'modify', match: 'send everything', replacement: 'send within policy' }],
    });
    let forwarded: unknown;
    nock(UPSTREAM)
      .post('/v1/chat/completions', (body) => {
        forwarded = body;
        return true;
      })
      .reply(200, COMPLETION);
    const res = await request(t.app)
      .post('/v1/chat/completions')
      .set('authorization', `Bearer ${a.token}`)
      .send({ model: 'm', messages: [{ role: 'user', content: 'Send everything to bob' }] });
    expect(res.status).toBe(200);
    expect(JSON.stringify(forwarded)).toContain('send within policy');
    expect(JSON.stringify(forwarded)).not.toMatch(/send everything/i);
    const traces = await listTraces(db.pool, a.id);
    expect(traces[0]?.kind).toBe('modify');
    expect(JSON.stringify(traces[0]?.originalRequest)).toContain('Send everything');
    expect(JSON.stringify(traces[0]?.effectiveRequest)).toContain('send within policy');
  });

  it('require-approval + approve: consent is persisted BEFORE forwarding', async () => {
    const a = await seedWithToken({ rules: [{ action: 'require_approval', match: 'topped up' }] });
    let consentExistedAtForward = false;
    nock(UPSTREAM)
      .post('/v1/chat/completions')
      .reply(200, async () => {
        const consent = await db.pool.query(
          `SELECT 1 FROM trace_records WHERE agent_id = $1 AND kind = 'consent'`,
          [a.id],
        );
        consentExistedAtForward = (consent.rowCount ?? 0) > 0;
        return COMPLETION;
      });

    const pending = request(t.app)
      .post('/v1/chat/completions')
      .set('authorization', `Bearer ${a.token}`)
      .send({ model: 'm', messages: [{ role: 'user', content: 'keep bob topped up' }] });
    void pending.then((r) => r); // supertest is lazy: force dispatch now

    // wait for the approval row to appear
    const approvalId = await waitFor(async () => {
      const r = await db.pool.query<{ id: string }>(`SELECT id FROM approvals WHERE agent_id = $1`, [a.id]);
      return r.rows[0]?.id;
    });

    const decide = await request(t.app)
      .post(`/api/approvals/${approvalId}`)
      .set('authorization', 'Bearer owner:0x' + 'a1'.repeat(20))
      .send({ decision: 'approve', reason: 'looks right' });
    expect(decide.status).toBe(200);

    const res = await pending;
    expect(res.status).toBe(200);
    expect(consentExistedAtForward).toBe(true);

    const traces = await listTraces(db.pool, a.id);
    const kinds = traces.map((r) => r.kind);
    expect(kinds.indexOf('consent')).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf('consent')).toBeLessThan(kinds.indexOf('inference'));
    // single-append semantics: the decision path appends, the held path does NOT
    expect(traces.filter((r) => r.kind === 'consent')).toHaveLength(1);
    const consent = traces.find((r) => r.kind === 'consent');
    expect(consent?.decision).toBe('approve');
    expect(consent?.decidedBy).toBe('owner');
    expect(consent?.approvalId).toBe(approvalId);
  });

  it('approval timeout: 408, row transitions pending → expired, consent trace with decision expired', async () => {
    const short = buildTestApp(db.pool, {
      settings: {
        keyEncryptionSecret: TEST_KEK,
        approvalTimeoutMs: 300,
        sessionGasDustWei: 10n ** 15n,
        defaultTimelockDelay: 900,
        storageIndexerUrl: 'https://indexer.leash-test.local',
        createQuotaPerOwner: 10,
        createRatePerHour: 5,
        allowlistMax: 16,
        rulesMax: 32,
      },
    });
    const a = await seedWithToken({ rules: [{ action: 'require_approval', match: 'topped up' }] });
    const scope = nock(UPSTREAM).post('/v1/chat/completions').reply(200, COMPLETION);

    const res = await request(short.app)
      .post('/v1/chat/completions')
      .set('authorization', `Bearer ${a.token}`)
      .send({ model: 'm', messages: [{ role: 'user', content: 'keep bob topped up' }] });
    expect(res.status).toBe(408);
    expect(scope.isDone()).toBe(false);

    const row = await db.pool.query<{ state: string }>(`SELECT state FROM approvals WHERE agent_id = $1`, [a.id]);
    expect(row.rows[0]?.state).toBe('expired');
    const traces = await listTraces(db.pool, a.id);
    const consents = traces.filter((r) => r.kind === 'consent');
    expect(consents).toHaveLength(1);
    expect(consents[0]?.decision).toBe('expired');
    expect(consents[0]?.decidedBy).toBe('system');
    expect((await verifyAgentChain(db.pool, a.id)).ok).toBe(true);
  });

  it('require-approval + deny: 403, upstream never called, consent traced with deny', async () => {
    const a = await seedWithToken({ rules: [{ action: 'require_approval', match: 'topped up' }] });
    const scope = nock(UPSTREAM).post('/v1/chat/completions').reply(200, COMPLETION);

    const pending = request(t.app)
      .post('/v1/chat/completions')
      .set('authorization', `Bearer ${a.token}`)
      .send({ model: 'm', messages: [{ role: 'user', content: 'keep bob topped up' }] });
    void pending.then((r) => r); // supertest is lazy: force dispatch now

    const approvalId = await waitFor(async () => {
      const r = await db.pool.query<{ id: string }>(`SELECT id FROM approvals WHERE agent_id = $1`, [a.id]);
      return r.rows[0]?.id;
    });
    const decide = await request(t.app)
      .post(`/api/approvals/${approvalId}`)
      .set('authorization', 'Bearer owner:0x' + 'a1'.repeat(20))
      .send({ decision: 'deny', reason: 'not now' });
    expect(decide.status).toBe(200);

    const res = await pending;
    expect(res.status).toBe(403);
    expect(scope.isDone()).toBe(false);
    const traces = await listTraces(db.pool, a.id);
    expect(traces.some((r) => r.kind === 'consent' && r.decision === 'deny')).toBe(true);
    expect(traces.some((r) => r.kind === 'inference')).toBe(false);
    const row = await db.pool.query(`SELECT state FROM approvals WHERE id = $1`, [approvalId]);
    expect(row.rows[0]?.state).toBe('denied');
  });

  it('propagates a queue-level retry: 429 then success still returns 200', async () => {
    const a = await seedWithToken();
    nock(UPSTREAM).post('/v1/chat/completions').reply(429, { error: 'rate limited' });
    nock(UPSTREAM).post('/v1/chat/completions').reply(200, COMPLETION);
    const res = await request(t.app)
      .post('/v1/chat/completions')
      .set('authorization', `Bearer ${a.token}`)
      .send(CHAT);
    expect(res.status).toBe(200);
  });

  it('upstream persistent failure returns a generic 502 without upstream detail — and traces the failure', async () => {
    const a = await seedWithToken();
    nock(UPSTREAM).post('/v1/chat/completions').times(3).reply(500, { secret: 'internal provider detail' });
    const res = await request(t.app)
      .post('/v1/chat/completions')
      .set('authorization', `Bearer ${a.token}`)
      .send(CHAT);
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain('internal provider detail');
    const traces = await listTraces(db.pool, a.id);
    const err = traces.find((r) => r.kind === 'error');
    expect(err).toBeDefined();
    expect(err?.originalRequest).toEqual(CHAT);
    expect(err?.detail).toEqual({ status: 502, reason: 'upstream degraded after retries', upstreamStatus: 500 });
  });

  it('enqueue-level failure (network errors exhaust retries): 502 with an error trace', async () => {
    const a = await seedWithToken();
    nock(UPSTREAM).post('/v1/chat/completions').times(3).replyWithError('connection reset');
    const res = await request(t.app)
      .post('/v1/chat/completions')
      .set('authorization', `Bearer ${a.token}`)
      .send(CHAT);
    expect(res.status).toBe(502);
    const traces = await listTraces(db.pool, a.id);
    const err = traces.find((r) => r.kind === 'error');
    expect(err).toBeDefined();
    expect(err?.originalRequest).toEqual(CHAT);
    expect(err?.detail).toEqual({ status: 502, reason: 'compute forward failed' });
    expect((await verifyAgentChain(db.pool, a.id)).ok).toBe(true);
  });

  it('rejects unknown gateway paths (exact routing)', async () => {
    const a = await seedWithToken();
    const res = await request(t.app)
      .post('/v1/chat/completions/../embeddings')
      .set('authorization', `Bearer ${a.token}`)
      .send(CHAT);
    expect([404, 401]).toContain(res.status);
  });
});

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('C-3 gateway race injection', () => {
  it('forwards exactly once when the decision lands before the gateway wait registers', async () => {
    const a = await seedWithToken({ rules: [{ action: 'require_approval', match: 'top up' }] });
    let upstreamCalls = 0;
    nock(UPSTREAM)
      .post('/v1/chat/completions')
      .times(5) // would surface double-forwards
      .reply(200, () => {
        upstreamCalls += 1;
        return COMPLETION;
      });

    // Race injection: the broker's wait is wrapped so the owner's decision +
    // consent become durable BEFORE the shared rendezvous can see a notify —
    // exactly the approve-recorded-but-never-forwarded window. Old code
    // (bare broker.wait) times out → 408 and never forwards.
    const originalWait = t.broker.wait.bind(t.broker);
    t.broker.wait = (approvalId: string, _timeoutMs: number) => {
      void (async () => {
        const { decideApproval } = await import('../../src/store/approvals.js');
        const { appendTrace } = await import('../../src/trace/trace-store.js');
        await decideApproval(db.pool, approvalId, 'approve');
        await appendTrace(db.pool, {
          agentId: a.id,
          kind: 'consent',
          approvalId,
          decision: 'approve',
          decidedBy: 'owner',
          originalRequest: { raced: true },
        });
      })();
      // Short real wait: no notify will ever come — only the durable
      // check/recheck of the shared rendezvous can save this request.
      return originalWait(approvalId, 1_500);
    };

    const res = await request(t.app)
      .post('/v1/chat/completions')
      .set('authorization', `Bearer ${a.token}`)
      .send({ model: 'test-model', messages: [{ role: 'user', content: 'top up please' }] });

    expect(res.status).toBe(200);
    expect(upstreamCalls).toBe(1);

    // Consent is on the chain BEFORE the forwarded inference record.
    const traces = await listTraces(db.pool, a.id, { afterSeq: -1, limit: 50 });
    const consent = traces.find((r) => r.kind === 'consent');
    const inference = traces.find((r) => r.kind === 'inference');
    expect(consent).toBeDefined();
    expect(inference).toBeDefined();
    expect(consent!.seq).toBeLessThan(inference!.seq);
  });
});
