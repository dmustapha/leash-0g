import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { encodeFunctionData, parseAbi, toFunctionSelector } from 'viem';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { buildTestApp, testSettings, ownerAuth, type TestApp } from '../helpers/app.js';
import { getAgentById } from '../../src/store/agents.js';
import { classifyIntendedCall } from '../../src/gateway/call-gate.js';
import { type GrantState } from '../../src/governed-call/index.js';
import { raiseCapabilityRequest, type CapabilityDeps } from '../../src/capabilities/service.js';
import { createApproval } from '../../src/store/approvals.js';

/**
 * Stage D owner API (spec §4): capability preset/rule/envelope routes + the JIT
 * decision branch on POST /api/approvals/:id. Owner-authed + owner-scoped;
 * grant txs are client-side-signed (the route records the read-model after the
 * owner reports the hash — never submits the tx). Includes a regression check
 * that the existing (non-capability) approval decision path is untouched.
 */

let db: TestDb;
let t: TestApp;
const OWNER = '0x' + 'a1'.repeat(20);
const OTHER = '0x' + 'f2'.repeat(20);
const ROUTER = '0x' + 'd0'.repeat(20); // matches testSettings catalog
const TOKEN = '0x' + 'c0'.repeat(20);
const SELF = '0x' + '55'.repeat(20);

// Realistic client-signed grant tx hashes (the route enforces /^0x[0-9a-fA-F]{64}$/
// after the L-02 tightening — the owner reports a real on-chain hash, never a stub).
const TX_PRESET = '0x' + '1a'.repeat(32);
const TX_PROPOSE = '0x' + '2b'.repeat(32);
const TX_TIGHTEN = '0x' + '3c'.repeat(32);
const TX_ALWAYS_ALLOW = '0x' + '4d'.repeat(32);
const TX_APPROVE_ONCE = '0x' + '5e'.repeat(32);

const erc20 = parseAbi(['function approve(address,uint256)']);
const encApprove = (spender: string, amt: bigint): string =>
  encodeFunctionData({ abi: erc20, functionName: 'approve', args: [spender as `0x${string}`, amt] });

const approveSelector = toFunctionSelector('function approve(address,uint256)');
const customRule = {
  target: TOKEN,
  selector: approveSelector,
  recipientMode: 'self' as const,
  spenderSet: [ROUTER],
  perCallCap: '100000000',
  windowCapCall: '500000000',
};

function emptyGrant(): GrantState {
  return { rules: new Map(), budgets: new Map(), allowlist: new Set<string>() };
}

function capDeps(): CapabilityDeps {
  return { pool: db.pool, hub: t.hub, broker: t.broker, alerts: t.alerts, jitTtlMs: 600_000 };
}

async function seedOwned(owner = OWNER): Promise<NonNullable<Awaited<ReturnType<typeof getAgentById>>>> {
  // SE-6 pre-req: no fixed accountAddr — UNIQUE(owner, chain, account) forbids
  // re-seeding one address per owner; classifyIntendedCall takes SELF directly.
  const id = await seedAgent(db.pool, { ownerAddr: owner, name: 'MyTrader' });
  const a = await getAgentById(db.pool, id);
  if (!a) throw new Error('agent');
  return a;
}

beforeAll(async () => {
  db = await createTestDb();
  t = buildTestApp(db.pool);
});
afterAll(async () => {
  await db.drop();
});

describe('POST /api/agents/:id/capabilities/preset', () => {
  it('dry-resolves a preset (no tx) without recording, then records when a tx is reported', async () => {
    const a = await seedOwned();
    const dry = await request(t.app)
      .post(`/api/agents/${a.id}/capabilities/preset`)
      .set('authorization', ownerAuth(OWNER))
      .send({ presetKey: 'defi_trader' });
    expect(dry.status).toBe(200);
    expect(dry.body.recorded).toBe(false);
    expect(dry.body.preset.rules.length).toBeGreaterThan(0);
    // nothing recorded yet
    let env = await request(t.app).get(`/api/agents/${a.id}/capabilities`).set('authorization', ownerAuth(OWNER));
    expect(env.body.grants).toHaveLength(0);

    const rec = await request(t.app)
      .post(`/api/agents/${a.id}/capabilities/preset`)
      .set('authorization', ownerAuth(OWNER))
      .send({ presetKey: 'defi_trader', txHash: TX_PRESET });
    expect(rec.body.recorded).toBe(true);
    env = await request(t.app).get(`/api/agents/${a.id}/capabilities`).set('authorization', ownerAuth(OWNER));
    expect(env.body.grants.length).toBe(dry.body.preset.rules.length);
    expect(env.body.presets).toContain('defi_trader');
  });

  it('rejects an unknown preset (400)', async () => {
    const a = await seedOwned();
    const res = await request(t.app)
      .post(`/api/agents/${a.id}/capabilities/preset`)
      .set('authorization', ownerAuth(OWNER))
      .send({ presetKey: 'not_a_preset' });
    expect(res.status).toBe(400);
  });

  it('returns 422 unresolvable_target when the network catalog lacks a referenced target', async () => {
    const app2 = buildTestApp(db.pool, { settings: testSettings({ capabilityCatalog: { settlement_token: TOKEN } }) });
    const a = await seedOwned();
    const res = await request(app2.app)
      .post(`/api/agents/${a.id}/capabilities/preset`)
      .set('authorization', ownerAuth(OWNER))
      .send({ presetKey: 'defi_trader' }); // needs router — absent
    expect(res.status).toBe(422);
    expect(res.body.error.message).toBe('unresolvable_target');
  });

  it('is owner-scoped (404 for another owner (enumeration-safe), 404 for a missing agent)', async () => {
    const a = await seedOwned();
    const forbidden = await request(t.app)
      .post(`/api/agents/${a.id}/capabilities/preset`)
      .set('authorization', ownerAuth(OTHER))
      .send({ presetKey: 'defi_trader' });
    expect(forbidden.status).toBe(404);
    const missing = await request(t.app)
      .post(`/api/agents/00000000-0000-0000-0000-000000000000/capabilities/preset`)
      .set('authorization', ownerAuth(OWNER))
      .send({ presetKey: 'defi_trader' });
    expect(missing.status).toBe(404);
  });
});

describe('POST /api/agents/:id/capabilities/rule', () => {
  it('propose records proposed; tighten flips to active; remove hides it', async () => {
    const a = await seedOwned();
    await request(t.app)
      .post(`/api/agents/${a.id}/capabilities/rule`)
      .set('authorization', ownerAuth(OWNER))
      .send({ action: 'propose', rule: customRule, txHash: TX_PROPOSE });
    let env = await request(t.app).get(`/api/agents/${a.id}/capabilities`).set('authorization', ownerAuth(OWNER));
    expect(env.body.grants).toHaveLength(1);
    expect(env.body.grants[0].status).toBe('proposed');

    await request(t.app)
      .post(`/api/agents/${a.id}/capabilities/rule`)
      .set('authorization', ownerAuth(OWNER))
      .send({ action: 'tighten', rule: { ...customRule, perCallCap: '10000000' }, txHash: TX_TIGHTEN });
    env = await request(t.app).get(`/api/agents/${a.id}/capabilities`).set('authorization', ownerAuth(OWNER));
    expect(env.body.grants[0].status).toBe('active');
    expect(env.body.grants[0].perCallCap).toBe('10000000');

    await request(t.app)
      .post(`/api/agents/${a.id}/capabilities/rule`)
      .set('authorization', ownerAuth(OWNER))
      .send({ action: 'remove', rule: customRule });
    env = await request(t.app).get(`/api/agents/${a.id}/capabilities`).set('authorization', ownerAuth(OWNER));
    expect(env.body.grants).toHaveLength(0);
  });

  it('apply on a removed grant → 409, read-model stays removed (DM-1: no resurrection)', async () => {
    const a = await seedOwned();
    // propose → remove: the grant is now terminal.
    await request(t.app)
      .post(`/api/agents/${a.id}/capabilities/rule`)
      .set('authorization', ownerAuth(OWNER))
      .send({ action: 'propose', rule: customRule, txHash: TX_PROPOSE });
    await request(t.app)
      .post(`/api/agents/${a.id}/capabilities/rule`)
      .set('authorization', ownerAuth(OWNER))
      .send({ action: 'remove', rule: customRule });
    // a bare apply must NOT flip it back to active.
    const res = await request(t.app)
      .post(`/api/agents/${a.id}/capabilities/rule`)
      .set('authorization', ownerAuth(OWNER))
      .send({ action: 'apply', rule: customRule });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe('grant is removed');
    // read-model honesty: still hidden (removed), never resurrected to active.
    const env = await request(t.app).get(`/api/agents/${a.id}/capabilities`).set('authorization', ownerAuth(OWNER));
    expect(env.body.grants).toHaveLength(0);
  });

  it('apply on a proposed grant still flips it to active (legitimate matured apply)', async () => {
    const a = await seedOwned();
    await request(t.app)
      .post(`/api/agents/${a.id}/capabilities/rule`)
      .set('authorization', ownerAuth(OWNER))
      .send({ action: 'propose', rule: customRule, txHash: TX_PROPOSE });
    const res = await request(t.app)
      .post(`/api/agents/${a.id}/capabilities/rule`)
      .set('authorization', ownerAuth(OWNER))
      .send({ action: 'apply', rule: customRule });
    expect(res.status).toBe(200);
    const env = await request(t.app).get(`/api/agents/${a.id}/capabilities`).set('authorization', ownerAuth(OWNER));
    expect(env.body.grants[0].status).toBe('active');
  });

  it('rejects a malformed rule (400)', async () => {
    const a = await seedOwned();
    const res = await request(t.app)
      .post(`/api/agents/${a.id}/capabilities/rule`)
      .set('authorization', ownerAuth(OWNER))
      .send({ action: 'propose', rule: { target: 'nope', selector: '0x12', recipientMode: 'self', perCallCap: '1', windowCapCall: '1' } });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/approvals/:id — capability (JIT) decision branch', () => {
  async function seedPending(a: NonNullable<Awaited<ReturnType<typeof getAgentById>>>, amt = 5n) {
    const gate = classifyIntendedCall(TOKEN, 0n, encApprove(ROUTER, amt), emptyGrant(), SELF);
    const { request: req } = await raiseCapabilityRequest(capDeps(), a, gate);
    return req;
  }

  it('always-allow (with tx + rule) resolves the request + records a jit grant', async () => {
    const a = await seedOwned();
    const req = await seedPending(a, 21n);
    const res = await request(t.app)
      .post(`/api/approvals/${req.approvalId}`)
      .set('authorization', ownerAuth(OWNER))
      .send({ decision: 'always_allow', txHash: TX_ALWAYS_ALLOW, rule: customRule });
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe('always_allowed');
    const env = await request(t.app).get(`/api/agents/${a.id}/capabilities`).set('authorization', ownerAuth(OWNER));
    expect((env.body.grants as Array<{ source: string }>).some((g) => g.source === 'jit')).toBe(true);
    expect((env.body.recentRequests as Array<{ status: string }>).some((r) => r.status === 'always_allowed')).toBe(true);
  });

  it('approve-once requires a tx (missing → 400) and is single-shot (2nd → 409)', async () => {
    const a = await seedOwned();
    const req = await seedPending(a, 23n);
    const noTx = await request(t.app)
      .post(`/api/approvals/${req.approvalId}`)
      .set('authorization', ownerAuth(OWNER))
      .send({ decision: 'approve_once' });
    expect(noTx.status).toBe(400);
    const ok = await request(t.app)
      .post(`/api/approvals/${req.approvalId}`)
      .set('authorization', ownerAuth(OWNER))
      .send({ decision: 'approve_once', txHash: TX_APPROVE_ONCE });
    expect(ok.status).toBe(200);
    const again = await request(t.app)
      .post(`/api/approvals/${req.approvalId}`)
      .set('authorization', ownerAuth(OWNER))
      .send({ decision: 'approve_once', txHash: TX_APPROVE_ONCE });
    expect(again.status).toBe(409);
  });

  it('deny stands down with no tx', async () => {
    const a = await seedOwned();
    const req = await seedPending(a, 25n);
    const res = await request(t.app)
      .post(`/api/approvals/${req.approvalId}`)
      .set('authorization', ownerAuth(OWNER))
      .send({ decision: 'deny' });
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe('denied');
  });

  it('C-SF3-2 parity: a capability approval whose requestRef points to ANOTHER agent’s request is refused (404)', async () => {
    // Defense-in-depth (tear-apart 2026-10-13): craft the invariant break the
    // guard protects against — an approval on agent A whose requestRef.requestId
    // points at agent B’s capability request. The decide must 404 (not act on B’s
    // request via A’s approval), mirroring the tool/signing branches.
    const a = await seedOwned();
    const b = await seedOwned();
    const reqB = await seedPending(b, 27n); // capability request belongs to agent B
    const crafted = await createApproval(db.pool, a.id, { type: 'capability', requestId: reqB.id });
    const res = await request(t.app)
      .post(`/api/approvals/${crafted.id}`)
      .set('authorization', ownerAuth(OWNER))
      .send({ decision: 'deny' });
    expect(res.status).toBe(404); // request.agentId (B) !== approval’s agent.id (A)
  });

  it('regression: a NON-capability approval still uses the approve/deny consent path', async () => {
    const a = await seedOwned();
    const approval = await createApproval(db.pool, a.id, { type: 'gateway', ruleIndex: 0 });
    const res = await request(t.app)
      .post(`/api/approvals/${approval.id}`)
      .set('authorization', ownerAuth(OWNER))
      .send({ decision: 'deny' });
    expect(res.status).toBe(200);
    expect(res.body.approval.state).toBe('denied');
  });
});

describe('GET /api/agents/:id/capabilities — owner words (beta step 3b)', () => {
  it('re-says a request stored in raw terms in the token words, and names the grant addresses', async () => {
    const a = await seedOwned();
    // A request raised WITHOUT a describer = what an older build stored: raw base-units text.
    const gate = classifyIntendedCall(TOKEN, 0n, encApprove(ROUTER, 1_000_000n), emptyGrant(), SELF);
    const { request: req } = await raiseCapabilityRequest(capDeps(), a, gate);
    expect((req.decoded as { humanReadable: string }).humanReadable).toContain('base-units');
    const chain = t.chain as unknown as { getErc20Meta: () => Promise<{ symbol: string; decimals: number }> };
    chain.getErc20Meta = async () => ({ symbol: 'USDC', decimals: 6 });
    await request(t.app)
      .post(`/api/agents/${a.id}/capabilities/rule`)
      .set('authorization', ownerAuth(OWNER))
      .send({ action: 'propose', txHash: TX_PROPOSE, rule: customRule });

    const res = await request(t.app).get(`/api/agents/${a.id}/capabilities`).set('authorization', ownerAuth(OWNER));
    expect(res.status).toBe(200);
    const row = res.body.recentRequests.find((r: { id: string }) => r.id === req.id);
    expect(row.decoded.humanReadable).toContain('1 USDC');
    expect(row.decoded.humanReadable).not.toContain('base-units');
    expect(res.body.labels[TOKEN]).toEqual({ name: 'USDC token', symbol: 'USDC', decimals: 6 });
  });

  it('an unreadable token keeps the stored text and null labels (never blocks the page)', async () => {
    const a = await seedOwned();
    const gate = classifyIntendedCall(TOKEN, 0n, encApprove(ROUTER, 7n), emptyGrant(), SELF);
    const { request: req } = await raiseCapabilityRequest(capDeps(), a, gate);
    const chain = t.chain as unknown as { getErc20Meta: () => Promise<never> };
    chain.getErc20Meta = async () => { throw new Error('rpc down'); };
    const res = await request(t.app).get(`/api/agents/${a.id}/capabilities`).set('authorization', ownerAuth(OWNER));
    expect(res.status).toBe(200);
    const row = res.body.recentRequests.find((r: { id: string }) => r.id === req.id);
    expect(row.decoded.humanReadable).toContain('7');
  });
});
