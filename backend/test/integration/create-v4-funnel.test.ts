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

async function createAndFetch(t: Pick<TestApp, 'app'>, owner: string, body: Record<string, unknown>) {
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
 * AQ-FND Lane-B — the v6 default flip: a version-less create resolves the CHAIN's
 * configured default (6 where the V6 singleton set is wired), fails CLOSED with a
 * typed 409 on a chain that cannot mint v6, and keeps every explicit pin working.
 */
describe('AQ-FND Lane-B — chain-default accountVersion 6', () => {
  function withV6Default(v6Supported: boolean) {
    // buildTestApp returns ITS OWN FakeChainOps even when one is injected — build
    // the chain first and assert against this reference, not the returned handle.
    const base = buildTestApp(db.pool);
    const chain = base.chain;
    chain.v6Supported = v6Supported;
    const t = buildTestApp(db.pool, {
      chain,
      chainRegistry: {
        has: () => true,
        getChainOps: () => chain,
        getChainConfig: () => ({ accountVersion: 6 }),
      } as never,
    });
    return { app: t.app, chain };
  }

  it('a version-less create on a v6-default chain mints V6, persists account_version=6', async () => {
    const owner = uniqueOwner();
    const t = withV6Default(true);
    const { row } = await createAndFetch(t, owner, createBody('default-v6'));
    expect(t.chain.createdVersions.at(-1)).toBe(6);
    expect(row?.accountVersion).toBe(6);
  });

  it('a v6-default chain MISSING the singletons is a typed 409 — never a silent V4 downgrade', async () => {
    const owner = uniqueOwner();
    const t = withV6Default(false);
    const res = await request(t.app)
      .post('/api/agents')
      .set('authorization', ownerAuth(owner))
      .send(createBody('v6-unavailable'));
    expect(res.status).toBe(409);
    expect(res.body.error?.reason).toBe('v6_unavailable');
    expect(t.chain.createdVersions).toHaveLength(0);
  });

  it('an explicit accountVersion:4 pin still mints V4 on a v6-default chain', async () => {
    const owner = uniqueOwner();
    const t = withV6Default(true);
    const { row } = await createAndFetch(t, owner, createBody('pinned-v4', { accountVersion: 4 }));
    expect(t.chain.createdVersions.at(-1)).toBe(4);
    expect(row?.accountVersion).toBe(4);
  });

  it('G-1 mirror: a v6 tokenConfig with windowCap < perTransferCap is a clean 400', async () => {
    const owner = uniqueOwner();
    const t = withV6Default(true);
    const res = await request(t.app)
      .post('/api/agents')
      .set('authorization', ownerAuth(owner))
      .send(
        createBody('bad-asset-policy', {
          tokenConfig: {
            settlementToken: '0x' + 'cc'.repeat(20),
            perTransferCapTokenWei: '1000',
            windowCapTokenWei: '999',
          },
        }),
      );
    expect(res.status).toBe(400);
    expect(res.body.error?.reason).toBe('invalid_token_policy');
  });

  it('a spend-capable non-requester (treasury) may now seed an initial asset (generalized F1)', async () => {
    const owner = uniqueOwner();
    const t = withV6Default(true);
    const { row } = await createAndFetch(
      t,
      owner,
      createBody('treasury-with-asset', {
        tokenConfig: {
          settlementToken: '0x' + 'cc'.repeat(20),
          perTransferCapTokenWei: '1000',
          windowCapTokenWei: '5000',
        },
      }),
    );
    expect(t.chain.createdVersions.at(-1)).toBe(6);
    expect(row?.accountVersion).toBe(6);
  });

  it('Gate-② B-1: a non-requester tokenConfig on a v4-default chain is a typed 400, never an unvalidated settlement path', async () => {
    const owner = uniqueOwner();
    const t = buildTestApp(db.pool); // no chainRegistry → chain default v4
    const res = await request(t.app)
      .post('/api/agents')
      .set('authorization', ownerAuth(owner))
      .send(
        createBody('treasury-token-v4', {
          tokenConfig: {
            settlementToken: '0x' + 'cc'.repeat(20),
            perTransferCapTokenWei: '1000',
            windowCapTokenWei: '5000',
          },
        }),
      );
    expect(res.status).toBe(400);
    expect(res.body.error?.reason).toBe('token_config_requires_v6');
    expect(t.chain.createdVersions).toHaveLength(0);
  });

  it('a spend-incapable role (sentinel) with tokenConfig is still refused at the schema', async () => {
    const owner = uniqueOwner();
    const t = withV6Default(true);
    const res = await request(t.app)
      .post('/api/agents')
      .set('authorization', ownerAuth(owner))
      .send({
        ...createBody('sentinel-token', {
          tokenConfig: {
            settlementToken: '0x' + 'cc'.repeat(20),
            perTransferCapTokenWei: '1000',
            windowCapTokenWei: '5000',
          },
        }),
        goal: {
          type: 'sentinel',
          beneficiary: '0x' + '9c'.repeat(20),
          targetBalanceWei: '50000000000000000',
          topUpWei: '5000000000000000',
        },
        allowlist: [],
      });
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
