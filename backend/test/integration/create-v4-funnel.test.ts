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
