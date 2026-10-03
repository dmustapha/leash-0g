import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { SseHub } from '../../src/sse/hub.js';
import { ApprovalBroker } from '../../src/approvals/broker.js';
import { AlertService } from '../../src/alerts/service.js';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { buildTestApp, ownerAuth, type TestApp } from '../helpers/app.js';
import { generateGatewayToken, hashTokenSecret } from '../../src/crypto/token.js';
import { createGovernedMcpProvider, createDbGrantLoader } from '../../src/gateway/mcp/governed-provider.js';
import { createHttpMcpEgressClient } from '../../src/gateway/mcp/egress.js';
import { upsertToolRule, listRecentToolRequests } from '../../src/store/tools.js';

/**
 * SF-3 F-3d [DEPLOY] — the governed tool-use path proven end-to-end over REAL
 * HTTP: a real external MCP server (echo tool) + the REAL fetch-based egress
 * client + the REAL gateway, exercising happy / off-allowlist-revert / owner-
 * intervene-mid-flight. Gated `RUN_DEPLOYED_DRILL=1` (SE-4 convention: the
 * deploy-class drills never run in plain CI). Idempotent (hermetic Neon per run)
 * + flake-tolerant (bounded poll). No mocks on the egress leg — this is the
 * "bound agent calls a REAL allowlisted MCP tool" criterion.
 */

const RUN = process.env.RUN_DEPLOYED_DRILL === '1';
const OWNER = '0x' + 'c9'.repeat(20);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(RUN ? describe : describe.skip)('SF-3 F-3d — governed tool-use on a live HTTP egress stack', () => {
  let db: TestDb;
  let mcpServer: http.Server;
  let origin: string;
  let t: TestApp;
  let token: string;
  let agentId: string;

  beforeAll(async () => {
    db = await createTestDb();

    // A REAL external MCP server: a JSON-RPC echo tool.
    mcpServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        const args = parsed?.params?.arguments ?? {};
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: parsed.id ?? 1,
            result: { content: [{ type: 'text', text: `echo:${JSON.stringify(args)}` }] },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => mcpServer.listen(0, '127.0.0.1', resolve));
    const port = (mcpServer.address() as AddressInfo).port;
    origin = `http://127.0.0.1:${port}`;

    const hub = new SseHub();
    hub.setOwnerLookup(async (id) => {
      const r = await db.pool.query<{ owner_addr: string }>(`SELECT owner_addr FROM agents WHERE id=$1`, [id]);
      return r.rows[0]?.owner_addr ?? null;
    });
    const broker = new ApprovalBroker();
    const alerts = new AlertService({ pool: db.pool, hub, settings: { alertRatePerOwnerPerHour: 1000 } });
    const mcpProvider = createGovernedMcpProvider({
      pool: db.pool,
      hub,
      broker,
      alerts,
      approvalTimeoutMs: 15_000,
      jitTtlMs: 600_000,
      egress: createHttpMcpEgressClient(),
      loadGrant: createDbGrantLoader(db.pool, {
        serverEndpoints: { search: `${origin}/rpc` },
        egressAllowlist: [origin],
      }),
    });
    t = buildTestApp(db.pool, { hub, broker, alerts, mcpProvider });
    const gen = generateGatewayToken();
    agentId = await seedAgent(db.pool, { ownerAddr: OWNER, tokenId: gen.tokenId, tokenHash: await hashTokenSecret(gen.secret) });
    token = gen.token;
    // Grant the read-only tool (allowlisted); sensitive tools stay always-ask.
    await upsertToolRule(db.pool, { agentId, ownerAddr: OWNER, rule: { toolId: 'search.web_search', allowed: true, sensitive: false }, source: 'custom', status: 'active' });
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => mcpServer.close(() => resolve()));
    await db.drop();
  });

  it('HAPPY: a bound agent calls a real allowlisted MCP tool and gets the real result', async () => {
    const res = await request(t.gatewayApp)
      .post('/mcp')
      .set('authorization', `Bearer ${token}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search.web_search', arguments: { query: 'leash' } } });
    expect(res.status).toBe(200);
    expect(res.body.result.content[0].text).toContain('echo:');
    expect(res.body.result.content[0].text).toContain('leash');
  });

  it('REVERT: an off-allowlist tool is refused at the proxy boundary (default-deny)', async () => {
    const res = await request(t.gatewayApp)
      .post('/mcp')
      .set('authorization', `Bearer ${token}`)
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'email.send_email', arguments: { to: 'a@b.com' } } });
    expect(res.body.error.code).toBe(-32003);
  });

  it('INTERVENE: a sensitive tool holds mid-flight; owner always_allow lets it through', async () => {
    await upsertToolRule(db.pool, { agentId, ownerAddr: OWNER, rule: { toolId: 'email.send_email', allowed: true, sensitive: true }, source: 'custom', status: 'active' });
    // Re-point email at the live echo server so an approved sensitive call can egress.
    const hub = new SseHub();
    hub.setOwnerLookup(async (id) => {
      const r = await db.pool.query<{ owner_addr: string }>(`SELECT owner_addr FROM agents WHERE id=$1`, [id]);
      return r.rows[0]?.owner_addr ?? null;
    });
    const broker = new ApprovalBroker();
    const alerts = new AlertService({ pool: db.pool, hub, settings: { alertRatePerOwnerPerHour: 1000 } });
    const provider = createGovernedMcpProvider({
      pool: db.pool, hub, broker, alerts, approvalTimeoutMs: 15_000, jitTtlMs: 600_000,
      egress: createHttpMcpEgressClient(),
      loadGrant: createDbGrantLoader(db.pool, { serverEndpoints: { email: `${origin}/rpc` }, egressAllowlist: [origin] }),
    });
    const app = buildTestApp(db.pool, { hub, broker, alerts, mcpProvider: provider });

    const pending = new Promise<request.Response>((resolve, reject) => {
      request(app.gatewayApp)
        .post('/mcp')
        .set('authorization', `Bearer ${token}`)
        .send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'email.send_email', arguments: { to: 'ok@leash.dev' } } })
        .then(resolve, reject);
    });
    let approvalId = '';
    for (let i = 0; i < 200 && !approvalId; i++) {
      const reqs = await listRecentToolRequests(db.pool, agentId, 5);
      const p = reqs.find((r) => r.status === 'pending' && r.approvalId);
      if (p?.approvalId) approvalId = p.approvalId;
      else await sleep(25);
    }
    expect(approvalId).not.toBe('');
    const decide = await request(app.ownerApp).post(`/api/approvals/${approvalId}`).set('authorization', ownerAuth(OWNER)).send({ decision: 'always_allow' });
    expect(decide.status).toBe(200);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body.result.content[0].text).toContain('echo:');
  }, 30_000);
});
