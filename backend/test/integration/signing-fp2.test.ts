import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { SseHub } from '../../src/sse/hub.js';
import { ApprovalBroker } from '../../src/approvals/broker.js';
import { AlertService } from '../../src/alerts/service.js';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { buildTestApp, ownerAuth, type TestApp } from '../helpers/app.js';
import { getAgentById } from '../../src/store/agents.js';
import {
  raiseSigningRequest,
  decideSigningRequest,
  reconcileAfterEpochBump,
  type SigningServiceDeps,
} from '../../src/signing/signing-service.js';
import {
  listSigningRules,
  listRecentSigningRequests,
  listSigningArms,
  recordSigningArm,
} from '../../src/store/signing.js';
import { onChainGrantParams, defaultSigningRegistry, computeSigningRequestHash } from '../../src/signing/index.js';

/**
 * F′ FP-2 — the off-chain governed-signing engine end-to-end: owner signing-policy
 * routes (read-model mirror + the N-01/N-02 floor), the sensitive-signing JIT rail
 * on the existing approval rail, and the FP-CARRY-4/5 arm reconcile (a tighten's
 * epoch-bump surfaces in-flight arms as stale).
 */

const OWNER = '0x' + 'c3'.repeat(20);
const SPENDER = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x0000000000000000000000000000000000000a11';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

interface H {
  t: TestApp;
  agentId: string;
  deps: SigningServiceDeps;
}

async function harness(): Promise<H> {
  const hub = new SseHub();
  hub.setOwnerLookup(async (agentId) => {
    const res = await db.pool.query<{ owner_addr: string }>(`SELECT owner_addr FROM agents WHERE id = $1`, [agentId]);
    return res.rows[0]?.owner_addr ?? null;
  });
  const broker = new ApprovalBroker();
  const alerts = new AlertService({ pool: db.pool, hub, settings: { alertRatePerOwnerPerHour: 1000 } });
  const t = buildTestApp(db.pool, { hub, broker, alerts });
  const agentId = await seedAgent(db.pool, { ownerAddr: OWNER, name: 'Signer' });
  const deps: SigningServiceDeps = { pool: db.pool, hub, broker, alerts, jitTtlMs: 600_000 };
  return { t, agentId, deps };
}

const DESC_ID = 1; // the built-in erc2612.permit descriptor.

describe('FP-2 owner signing-policy routes (read-model + N-01/N-02 floor)', () => {
  let h: H;
  beforeEach(async () => {
    h = await harness();
  });

  it('sets a signing rule and returns the on-chain grant params (engine-computed)', async () => {
    const res = await request(h.t.app)
      .post(`/api/agents/${h.agentId}/signing/rule`)
      .set('authorization', ownerAuth(OWNER))
      .send({
        action: 'set',
        rule: { descriptorId: DESC_ID, spenderSet: [SPENDER], perIntentCap: '1000', maxDeadlineWindow: 3600, token: TOKEN },
      });
    expect(res.status).toBe(200);
    const descriptor = defaultSigningRegistry.get(DESC_ID)!;
    expect(res.body.onChainGrant).toMatchObject(onChainGrantParams(descriptor));

    const rules = await listSigningRules(db.pool, h.agentId);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ descriptorId: DESC_ID, perIntentCap: '1000', spenderSet: [SPENDER.toLowerCase()] });
  });

  it('refuses an unknown descriptor (default-deny, never inferred — 00 §9)', async () => {
    const res = await request(h.t.app)
      .post(`/api/agents/${h.agentId}/signing/rule`)
      .set('authorization', ownerAuth(OWNER))
      .send({
        action: 'set',
        rule: { descriptorId: 999, spenderSet: [SPENDER], perIntentCap: '1', maxDeadlineWindow: 60, token: TOKEN },
      });
    expect(res.status).toBe(422);
  });

  it('GET /signing returns rules + reviewed descriptors with grant params', async () => {
    await request(h.t.app)
      .post(`/api/agents/${h.agentId}/signing/rule`)
      .set('authorization', ownerAuth(OWNER))
      .send({
        action: 'set',
        rule: { descriptorId: DESC_ID, spenderSet: [SPENDER], perIntentCap: '1000', maxDeadlineWindow: 3600, token: TOKEN },
      });
    const res = await request(h.t.app).get(`/api/agents/${h.agentId}/signing`).set('authorization', ownerAuth(OWNER));
    expect(res.status).toBe(200);
    expect(res.body.rules).toHaveLength(1);
    expect(res.body.available.some((d: { descriptorId: number }) => d.descriptorId === DESC_ID)).toBe(true);
    expect(res.body.arms).toEqual([]);
  });

  it('remove sets the rule removed', async () => {
    await request(h.t.app)
      .post(`/api/agents/${h.agentId}/signing/rule`)
      .set('authorization', ownerAuth(OWNER))
      .send({ action: 'set', rule: { descriptorId: DESC_ID, spenderSet: [SPENDER], perIntentCap: '1', maxDeadlineWindow: 60, token: TOKEN } });
    await request(h.t.app)
      .post(`/api/agents/${h.agentId}/signing/rule`)
      .set('authorization', ownerAuth(OWNER))
      .send({ action: 'remove', rule: { descriptorId: DESC_ID, spenderSet: [], perIntentCap: '0', maxDeadlineWindow: 0, token: TOKEN } });
    const rules = await listSigningRules(db.pool, h.agentId);
    expect(rules).toHaveLength(0); // removed rules excluded
  });
});

describe('FP-2 sensitive-signing JIT rail (decoded cards, consent, always-ask)', () => {
  let h: H;
  beforeEach(async () => {
    h = await harness();
  });

  async function raise() {
    const agent = (await getAgentById(db.pool, h.agentId))!;
    const requestHash = computeSigningRequestHash(agent.chainId, DESC_ID, SPENDER, '500', 2_000_000);
    return raiseSigningRequest(h.deps, agent, {
      descriptorId: DESC_ID,
      triggers: ['sensitive'],
      requestHash,
      humanReadable: 'Sign a ERC-2612 Permit: authorize 500 to 0x1111…1111, expires in ~30 min.',
      protocol: 'ERC-2612 Permit',
      spender: SPENDER,
      amountWei: '500',
      deadlineSec: 2_000_000,
      intent: { fields: ['0x00'], digest: '0xdeadbeef' },
    });
  }

  it('raises a quarantined UNVERIFIED request with a decoded card (never a raw blob)', async () => {
    const { request: row, created } = await raise();
    expect(created).toBe(true);
    expect(row.status).toBe('pending');
    expect(row.approvalId).toBeTruthy();
    expect((row.decoded as Record<string, unknown>)['label']).toBe('UNVERIFIED');
    expect((row.decoded as Record<string, unknown>)['humanReadable']).toMatch(/ERC-2612 Permit/);
  });

  it('is idempotent on identical (descriptor, spender, amount, deadline)', async () => {
    await raise();
    const again = await raise();
    expect(again.created).toBe(false);
    const reqs = await listRecentSigningRequests(db.pool, h.agentId, 10);
    expect(reqs.filter((r) => r.status === 'pending')).toHaveLength(1);
  });

  it('approve_once via the approval rail resolves the quarantine', async () => {
    const { request: row } = await raise();
    const res = await request(h.t.app)
      .post(`/api/approvals/${row.approvalId}`)
      .set('authorization', ownerAuth(OWNER))
      .send({ decision: 'approve_once' });
    expect(res.status).toBe(200);
    const reqs = await listRecentSigningRequests(db.pool, h.agentId, 10);
    expect(reqs[0]!.status).toBe('approved_once');
  });

  it('always_allow records a standing rule (but sensitive stays always-ask)', async () => {
    const { request: row } = await raise();
    const agent = (await getAgentById(db.pool, h.agentId))!;
    const outcome = await decideSigningRequest(
      h.deps,
      agent,
      row,
      'always_allow',
      { descriptorId: DESC_ID, descriptorKey: 'erc2612.permit', spenderSet: [SPENDER], perIntentCap: '500', maxDeadlineWindow: 3600, token: TOKEN },
    );
    expect(outcome.ok).toBe(true);
    const rules = await listSigningRules(db.pool, h.agentId);
    expect(rules.some((r) => r.descriptorId === DESC_ID && r.source === 'jit')).toBe(true);
  });

  it('a decision on a request belonging to another agent fails closed (agent_mismatch)', async () => {
    const { request: row } = await raise();
    const otherId = await seedAgent(db.pool, { ownerAddr: OWNER, name: 'Other' });
    const other = (await getAgentById(db.pool, otherId))!;
    const outcome = await decideSigningRequest(
      h.deps,
      other,
      row,
      'approve_once',
      { descriptorId: DESC_ID, descriptorKey: 'erc2612.permit', spenderSet: [SPENDER], perIntentCap: '1', maxDeadlineWindow: 60, token: TOKEN },
    );
    expect(outcome).toEqual({ ok: false, reason: 'agent_mismatch' });
  });
});

describe('FP-2 FP-CARRY-4/5 arm reconcile (a tighten epoch-bump → stale)', () => {
  it('marks an armed intent stale once the signing epoch advances past it', async () => {
    const h = await harness();
    const arm = await recordSigningArm(db.pool, {
      agentId: h.agentId,
      descriptorId: DESC_ID,
      digest: '0x' + 'ab'.repeat(32),
      spender: SPENDER,
      amount: '500',
      deadline: 2_000_000,
      epoch: 0,
    });
    expect(arm.status).toBe('armed');

    // owner tighten bumps the on-chain signingEpoch 0 → 1; reconcile the read-model.
    const n = await reconcileAfterEpochBump(h.deps, h.agentId, 1);
    expect(n).toBe(1);
    const arms = await listSigningArms(db.pool, h.agentId);
    expect(arms[0]!.status).toBe('stale');

    // idempotent — a second reconcile at the same epoch changes nothing.
    expect(await reconcileAfterEpochBump(h.deps, h.agentId, 1)).toBe(0);
  });

  it('leaves a current-epoch arm armed', async () => {
    const h = await harness();
    await recordSigningArm(db.pool, {
      agentId: h.agentId,
      descriptorId: DESC_ID,
      digest: '0x' + 'cd'.repeat(32),
      spender: SPENDER,
      amount: '10',
      deadline: 2_000_000,
      epoch: 5,
    });
    expect(await reconcileAfterEpochBump(h.deps, h.agentId, 5)).toBe(0);
    const arms = await listSigningArms(db.pool, h.agentId);
    expect(arms[0]!.status).toBe('armed');
  });
});
