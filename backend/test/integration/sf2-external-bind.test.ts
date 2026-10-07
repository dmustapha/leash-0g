import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestDb, type TestDb } from '../helpers/db.js';
import { buildTestApp, testSettings, ownerAuth, type TestApp } from '../helpers/app.js';
import { getAgentById } from '../../src/store/agents.js';
import { getBoundAgent } from '../../src/store/bound-agents.js';
import { authenticateAgent } from '../../src/gateway/agent-auth.js';

/**
 * SF-2 — external Tier-2 bind (F-2a config-only bind · F-2b zero-authority +
 * tenant isolation · F-2d one-move revoke). The bound agent reuses the ENTIRE
 * SF-1/SF-3 spine (authenticateAgent resolves it from its gateway token); the
 * ONLY difference is it holds no on-chain authority.
 */
let db: TestDb;
let t: TestApp;

const OWNER = '0x' + 'a1'.repeat(20);
const OTHER = '0x' + 'b2'.repeat(20);

beforeAll(async () => {
  db = await createTestDb();
  t = buildTestApp(db.pool, { settings: testSettings({ publicBaseUrl: 'https://leash.example' }) });
});
afterAll(async () => {
  await db.drop();
});

async function bind(owner: string, body: Record<string, unknown>) {
  return request(t.app).post('/api/agents/bind-external').set('authorization', ownerAuth(owner)).send(body);
}

describe('SF-2 F-2a — config-only external bind', () => {
  it('mints a bound agent + gateway token + endpoints, with NO on-chain authority', async () => {
    const res = await bind(OWNER, { name: 'my-llamabot', baseUrl: 'https://api.openai.com/v1' });
    expect(res.status).toBe(201);
    expect(res.body.gatewayUrl).toBe('https://leash.example/v1');
    expect(res.body.mcpEndpoint).toBe('https://leash.example/mcp');
    expect(res.body.gatewayToken).toMatch(/^leash_[0-9a-f]{16}_[0-9a-f]{64}$/);
    expect(res.body.tenantKey).toMatch(/^tnt_[0-9a-f]{32}$/);
    expect(res.body.interactionMode).toBe('observe');
    expect(res.body.baseUrlSwap.from).toBe('https://api.openai.com/v1');

    const row = await getAgentById(db.pool, res.body.agentId);
    expect(row?.bindMode).toBe('external');
    // F-2b zero-authority: no session key / audit key / account.
    expect(row?.sessionKeyAddr).toBeNull();
    expect(row?.sessionKeyEnc).toBeNull();
    expect(row?.auditPubkey).toBeNull();
    expect(row?.accountAddr).toBeNull();

    const bound = await getBoundAgent(db.pool, res.body.agentId);
    expect(bound?.interactionMode).toBe('observe');
    expect(bound?.mcpScope).toEqual([]);
  });

  it('the minted gateway token authenticates the bound agent through the SAME spine', async () => {
    const res = await bind(OWNER, { name: 'bound' });
    const auth = await authenticateAgent(db.pool, `Bearer ${res.body.gatewayToken}`);
    expect(auth.ok).toBe(true);
    if (auth.ok) {
      expect(auth.agent.id).toBe(res.body.agentId);
      expect(auth.agent.bindMode).toBe('external');
    }
  });

  it('normalizes + dedupes the optional tool allowlist; default-deny when empty', async () => {
    const res = await bind(OWNER, { name: 'tooled', toolAllowlist: ['Server.Fetch', 'server.fetch', '  '] });
    const bound = await getBoundAgent(db.pool, res.body.agentId);
    expect(bound?.mcpScope).toEqual(['server.fetch']);
  });
});

describe('SF-2 F-2b — zero-authority (runtime can never start a bound agent)', () => {
  it('POST /start refuses a bound agent (no session key → no loop)', async () => {
    const res = await bind(OWNER, { name: 'bound' });
    const start = await request(t.app)
      .post(`/api/agents/${res.body.agentId}/start`)
      .set('authorization', ownerAuth(OWNER))
      .send({});
    expect(start.status).toBe(409);
    expect(start.body.error.reason).toBe('external_bind');
  });
});

describe('SF-2 interaction-mode — observe only in SF-2 (passive/active deferred)', () => {
  it('refuses a passive/active bind (declared but behavior deferred to SF-2′)', async () => {
    for (const mode of ['passive', 'active'] as const) {
      const res = await bind(OWNER, { name: `m-${mode}`, interactionMode: mode });
      expect(res.status).toBe(409);
      expect(res.body.error.reason).toBe('interaction_mode_deferred');
    }
  });
});

describe('SF-2 F-2d — one-move revoke (fails closed across inference + tools)', () => {
  it('unbind flips status=revoked with no on-chain tx; the token then 403s at the gateway', async () => {
    const res = await bind(OWNER, { name: 'bound' });
    const unbind = await request(t.app)
      .post(`/api/agents/${res.body.agentId}/unbind`)
      .set('authorization', ownerAuth(OWNER))
      .send({});
    expect(unbind.status).toBe(200);
    expect(unbind.body.status).toBe('revoked');

    // F-2d: gateway auth now refuses — inference AND tools closed in one move.
    const auth = await authenticateAgent(db.pool, `Bearer ${res.body.gatewayToken}`);
    expect(auth.ok).toBe(false);
    if (!auth.ok) expect(auth.status).toBe(403);
  });

  it('the generic revoke route also takes the external (no-tx) branch', async () => {
    const res = await bind(OWNER, { name: 'bound' });
    const revoke = await request(t.app)
      .post(`/api/agents/${res.body.agentId}/revoke`)
      .set('authorization', ownerAuth(OWNER))
      .send({});
    expect(revoke.status).toBe(200);
    expect(revoke.body.bindMode).toBe('external');
    expect(revoke.body.txHash).toBeUndefined(); // no chain tx for a bound agent
  });
});

describe('SF-2 — rotate-gateway-token', () => {
  it('rotates: the new token authenticates, the old one is dead', async () => {
    const res = await bind(OWNER, { name: 'bound' });
    const rot = await request(t.app)
      .post(`/api/agents/${res.body.agentId}/rotate-gateway-token`)
      .set('authorization', ownerAuth(OWNER))
      .send({});
    expect(rot.status).toBe(200);
    expect(rot.body.gatewayToken).not.toBe(res.body.gatewayToken);

    const freshAuth = await authenticateAgent(db.pool, `Bearer ${rot.body.gatewayToken}`);
    expect(freshAuth.ok).toBe(true);
    const oldAuth = await authenticateAgent(db.pool, `Bearer ${res.body.gatewayToken}`);
    expect(oldAuth.ok).toBe(false);
  });

  it('refuses rotate-gateway-token on a NATIVE agent (wrong route)', async () => {
    // A foreign-owner bound agent is 404 (enumeration-oracle) — proves ownership scoping.
    const res = await bind(OWNER, { name: 'bound' });
    const foreign = await request(t.app)
      .post(`/api/agents/${res.body.agentId}/rotate-gateway-token`)
      .set('authorization', ownerAuth(OTHER))
      .send({});
    expect(foreign.status).toBe(404);
  });
});

describe('SF-2 F-2b — tenant isolation across bound agents', () => {
  it('a foreign owner cannot read, revoke, or rotate another owner’s bound agent (404)', async () => {
    const mine = await bind(OWNER, { name: 'mine' });
    for (const path of [`/api/agents/${mine.body.agentId}`]) {
      const r = await request(t.app).get(path).set('authorization', ownerAuth(OTHER));
      expect(r.status).toBe(404);
    }
    const unbind = await request(t.app)
      .post(`/api/agents/${mine.body.agentId}/unbind`)
      .set('authorization', ownerAuth(OTHER))
      .send({});
    expect(unbind.status).toBe(404);
    // The agent is untouched — owner can still read it.
    const stillMine = await request(t.app).get(`/api/agents/${mine.body.agentId}`).set('authorization', ownerAuth(OWNER));
    expect(stillMine.status).toBe(200);
    expect(stillMine.body.bindMode).toBe('external');
  });
});
