import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { PrivateKey } from 'eciesjs';
import { createTestDb, type TestDb } from '../helpers/db.js';
import { buildTestApp, ownerAuth, type TestApp } from '../helpers/app.js';
import { getAgentById } from '../../src/store/agents.js';

/**
 * SE-1 (Stage E, E-1 funnel half): the create funnel selects the account version.
 * Default (no field) → V4 (governed-calldata, SD-E7) — deployAndRegister receives
 * version 4 and the persisted row carries account_version=4. Explicit
 * accountVersion:2 → the legacy path (regression). An out-of-range version is
 * rejected at the schema (default-deny, never a silent legacy fallback).
 */

let db: TestDb;
const auditKey = new PrivateKey();
let ownerCounter = 0;
function uniqueOwner(): string {
  return '0x7f' + String(ownerCounter++).padStart(4, '0') + 'cd'.repeat(17);
}

function createBody(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
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
    ...extra,
  };
}

async function createAndFetch(t: TestApp, owner: string, body: Record<string, unknown>) {
  const res = await request(t.app).post('/api/agents').set('authorization', ownerAuth(owner)).send(body);
  expect(res.status).toBe(201);
  const row = await getAgentById(db.pool, res.body.agentId);
  return { res, row };
}

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

describe('SE-1 create funnel → version selection', () => {
  it('default (no accountVersion) → mints V4, persists account_version=4', async () => {
    const owner = uniqueOwner();
    const t = buildTestApp(db.pool);
    const { row } = await createAndFetch(t, owner, createBody('default-v4'));
    expect(t.chain.createdVersions.at(-1)).toBe(4);
    expect(row?.accountVersion).toBe(4);
  });

  it('accountVersion:2 → legacy path, persists account_version=2 (regression)', async () => {
    const owner = uniqueOwner();
    const t = buildTestApp(db.pool);
    const { row } = await createAndFetch(t, owner, createBody('legacy-v2', { accountVersion: 2 }));
    expect(t.chain.createdVersions.at(-1)).toBe(2);
    expect(row?.accountVersion).toBe(2);
  });

  it('an unsupported accountVersion (3) is rejected — never a silent legacy fallback', async () => {
    const owner = uniqueOwner();
    const t = buildTestApp(db.pool);
    const res = await request(t.app)
      .post('/api/agents')
      .set('authorization', ownerAuth(owner))
      .send(createBody('bad', { accountVersion: 3 }));
    expect(res.status).toBe(400);
  });
});

/**
 * RH2 (V5 migration, A1): the trader/oracleBand lane mints a governed-signing V5
 * account (NOT the V4 capability factory) so the swap wall budgets amountIn + pins
 * the recipient (closes SCOPE-RH2-1 — V4 left amountIn UNBUDGETED). Non-oracleBand
 * creates still mint V4 (legacy-safe, additive). A V5 lane on a chain missing the
 * V5 singletons fails-CLOSED with a typed 409 — never a silent V4 fallback.
 */
describe('RH2 — oracleBand create → V5 migration', () => {
  it("capability:'oracleBand' → mints accountVersion:5, persists account_version=5", async () => {
    const owner = uniqueOwner();
    const t = buildTestApp(db.pool);
    const { row } = await createAndFetch(t, owner, createBody('band-trader', { capability: 'oracleBand' }));
    expect(t.chain.createdVersions.at(-1)).toBe(5);
    expect(row?.accountVersion).toBe(5);
  });

  it('a trader goal WITHOUT the oracleBand capability STILL mints V5 (Gate-② W1 — any trader swaps, so no V4 drain)', async () => {
    const owner = uniqueOwner();
    const t = buildTestApp(db.pool);
    const traderGoal = {
      type: 'trader',
      holdToken: '0x' + 'aa'.repeat(20),
      spendToken: '0x' + 'bb'.repeat(20),
      targetHoldWei: '1000000000000000000',
      clipWei: '100000000000000000',
    };
    const { row } = await createAndFetch(t, owner, createBody('bare-trader', { goal: traderGoal }));
    expect(t.chain.createdVersions.at(-1)).toBe(5);
    expect(row?.accountVersion).toBe(5);
  });

  it('a non-oracleBand create (no capability) still mints V4', async () => {
    const owner = uniqueOwner();
    const t = buildTestApp(db.pool);
    const { row } = await createAndFetch(t, owner, createBody('plain-v4'));
    expect(t.chain.createdVersions.at(-1)).toBe(4);
    expect(row?.accountVersion).toBe(4);
  });

  it('a V5-trader create on a chain missing V5 singletons fails-CLOSED (409, never V4)', async () => {
    const owner = uniqueOwner();
    const t = buildTestApp(db.pool);
    t.chain.v5Supported = false;
    const res = await request(t.app)
      .post('/api/agents')
      .set('authorization', ownerAuth(owner))
      .send(createBody('band-no-singletons', { capability: 'oracleBand' }));
    expect(res.status).toBe(409);
    expect(res.body.error?.reason).toBe('v5_unavailable');
    // No silent fallback: nothing was minted.
    expect(t.chain.createdVersions).toHaveLength(0);
  });
});
