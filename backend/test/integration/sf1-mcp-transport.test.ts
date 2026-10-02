import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { buildTestApp, type TestApp } from '../helpers/app.js';
import { generateGatewayToken, hashTokenSecret } from '../../src/crypto/token.js';
import {
  McpToolForbidden,
  type McpToolProvider,
  type McpTenantContext,
} from '../../src/gateway/mcp/provider.js';

/**
 * SF-1 F-1b — the MCP transport: per-agent bearer auth, loopback/tenant scope,
 * and default-deny. The key invariant (BR-F2): the tenant context is derived
 * ONLY from the token, so a cross-tenant call is structurally impossible — a
 * `params.agentId` claiming another agent is ignored. A recording provider
 * asserts the ctx the transport hands it is ALWAYS the token's agent.
 */

let db: TestDb;

interface Seeded {
  id: string;
  token: string;
}
async function seed(): Promise<Seeded> {
  const gen = generateGatewayToken();
  const id = await seedAgent(db.pool, { tokenId: gen.tokenId, tokenHash: await hashTokenSecret(gen.secret) });
  return { id, token: gen.token };
}

/** A tenant-keyed provider: each agent owns exactly `tool_<agentId>`. */
function tenantKeyedProvider(seen: McpTenantContext[]): McpToolProvider {
  return {
    async listTools(ctx) {
      seen.push(ctx);
      return [{ name: `tool_${ctx.agentId}`, inputSchema: { type: 'object' } }];
    },
    async callTool(ctx, name) {
      seen.push(ctx);
      if (name !== `tool_${ctx.agentId}`) throw new McpToolForbidden(name);
      return { content: [{ type: 'text', text: `ran ${name} for ${ctx.agentId}` }] };
    },
  };
}

function rpc(method: string, params?: unknown, id: unknown = 1) {
  return { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };
}

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

describe('SF-1 F-1b — MCP auth', () => {
  let t: TestApp;
  beforeEach(() => {
    t = buildTestApp(db.pool);
  });

  it('401 without a bearer token (JSON-RPC-framed auth error)', async () => {
    const res = await request(t.gatewayApp).post('/mcp').send(rpc('tools/list'));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe(-32001);
  });

  it('401 with a malformed token', async () => {
    const res = await request(t.gatewayApp).post('/mcp').set('authorization', 'Bearer not-a-leash-token').send(rpc('ping'));
    expect(res.status).toBe(401);
  });

  it('403 for a revoked agent', async () => {
    const gen = generateGatewayToken();
    await seedAgent(db.pool, { tokenId: gen.tokenId, tokenHash: await hashTokenSecret(gen.secret), status: 'revoked' });
    const res = await request(t.gatewayApp).post('/mcp').set('authorization', `Bearer ${gen.token}`).send(rpc('ping'));
    expect(res.status).toBe(403);
  });
});

describe('SF-1 F-1b — MCP transport methods (default denyAll provider)', () => {
  let t: TestApp;
  beforeEach(() => {
    t = buildTestApp(db.pool);
  });

  it('initialize returns protocol version + capabilities', async () => {
    const a = await seed();
    const res = await request(t.gatewayApp).post('/mcp').set('authorization', `Bearer ${a.token}`).send(rpc('initialize'));
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ protocolVersion: expect.any(String), serverInfo: { name: 'leash-gateway' } });
  });

  it('tools/list is EMPTY in SF-1 (no tool policy yet — SF-3)', async () => {
    const a = await seed();
    const res = await request(t.gatewayApp).post('/mcp').set('authorization', `Bearer ${a.token}`).send(rpc('tools/list'));
    expect(res.body.result.tools).toEqual([]);
  });

  it('tools/call is default-DENIED (no tool is allowlisted in SF-1)', async () => {
    const a = await seed();
    const res = await request(t.gatewayApp)
      .post('/mcp')
      .set('authorization', `Bearer ${a.token}`)
      .send(rpc('tools/call', { name: 'anything', arguments: {} }));
    expect(res.body.error.code).toBe(-32003); // forbidden
  });

  it('a notification (no id) is accepted with 202 and no body', async () => {
    const a = await seed();
    const res = await request(t.gatewayApp)
      .post('/mcp')
      .set('authorization', `Bearer ${a.token}`)
      .send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.status).toBe(202);
    expect(res.text).toBe('');
  });

  it('an unknown method returns method-not-found', async () => {
    const a = await seed();
    const res = await request(t.gatewayApp).post('/mcp').set('authorization', `Bearer ${a.token}`).send(rpc('evil/escape'));
    expect(res.body.error.code).toBe(-32601);
  });

  it('a malformed JSON-RPC envelope is refused (invalid request)', async () => {
    const a = await seed();
    const res = await request(t.gatewayApp).post('/mcp').set('authorization', `Bearer ${a.token}`).send({ not: 'jsonrpc' });
    expect(res.body.error.code).toBe(-32600);
  });
});

describe('SF-1 F-1b — tenant scoping (cross-tenant is structurally impossible)', () => {
  it('derives the tenant from the TOKEN only; a params.agentId claiming another agent is ignored', async () => {
    const seen: McpTenantContext[] = [];
    const t = buildTestApp(db.pool, { mcpProvider: tenantKeyedProvider(seen) });
    const a = await seed();
    const b = await seed();

    // Agent A lists its tools → sees ONLY tool_<A>, even while claiming to be B.
    const listA = await request(t.gatewayApp)
      .post('/mcp')
      .set('authorization', `Bearer ${a.token}`)
      .send(rpc('tools/list', { agentId: b.id }));
    expect(listA.body.result.tools).toEqual([{ name: `tool_${a.id}`, inputSchema: { type: 'object' } }]);

    // Agent A tries to CALL agent B's tool → forbidden (scope is A, not B).
    const crossCall = await request(t.gatewayApp)
      .post('/mcp')
      .set('authorization', `Bearer ${a.token}`)
      .send(rpc('tools/call', { name: `tool_${b.id}`, arguments: {}, agentId: b.id }));
    expect(crossCall.body.error.code).toBe(-32003);

    // A calling its OWN tool works.
    const ownCall = await request(t.gatewayApp)
      .post('/mcp')
      .set('authorization', `Bearer ${a.token}`)
      .send(rpc('tools/call', { name: `tool_${a.id}`, arguments: {} }));
    expect(ownCall.body.result.content[0].text).toContain(a.id);

    // The provider was NEVER handed B's id on A's requests.
    expect(seen.every((ctx) => ctx.agentId === a.id)).toBe(true);
  });
});
