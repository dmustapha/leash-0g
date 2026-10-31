import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { PrivateKey } from 'eciesjs';
import { createTestDb, type TestDb } from '../helpers/db.js';
import { buildTestApp, ownerAuth, type TestApp } from '../helpers/app.js';

let db: TestDb;
let t: TestApp;

const OWNER = '0x' + '5a'.repeat(20);
const OTHER_OWNER = '0x' + '6b'.repeat(20);
const auditKey = new PrivateKey();

const CREATE_BODY = {
  name: 'gas-policy-agent',
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
});

beforeEach(() => {
  t = buildTestApp(db.pool);
});

afterAll(async () => {
  await db.drop();
});

async function createAgent(): Promise<string> {
  const res = await request(t.app).post('/api/agents').set('authorization', ownerAuth(OWNER)).send(CREATE_BODY);
  expect(res.status).toBe(201);
  return res.body.agentId as string;
}

describe('PATCH /api/agents/:id/gas-policy (AQ-FND M-3 relayer opt-in)', () => {
  it('defaults to false, owner can flip it, persists, and GET reflects it', async () => {
    const id = await createAgent();
    const before = await request(t.app).get(`/api/agents/${id}`).set('authorization', ownerAuth(OWNER));
    expect(before.body.agent.allowRelayerBootstrap).toBe(false);

    const on = await request(t.app)
      .patch(`/api/agents/${id}/gas-policy`)
      .set('authorization', ownerAuth(OWNER))
      .send({ allowRelayerBootstrap: true });
    expect(on.status).toBe(200);
    expect(on.body).toEqual({ ok: true, allowRelayerBootstrap: true });

    const row = await db.pool.query('SELECT allow_relayer_bootstrap FROM agents WHERE id = $1', [id]);
    expect(row.rows[0].allow_relayer_bootstrap).toBe(true);
    const after = await request(t.app).get(`/api/agents/${id}`).set('authorization', ownerAuth(OWNER));
    expect(after.body.agent.allowRelayerBootstrap).toBe(true);

    const off = await request(t.app)
      .patch(`/api/agents/${id}/gas-policy`)
      .set('authorization', ownerAuth(OWNER))
      .send({ allowRelayerBootstrap: false });
    expect(off.body).toEqual({ ok: true, allowRelayerBootstrap: false });
  });

  it('a foreign owner gets 404 and the flag is untouched', async () => {
    const id = await createAgent();
    const res = await request(t.app)
      .patch(`/api/agents/${id}/gas-policy`)
      .set('authorization', ownerAuth(OTHER_OWNER))
      .send({ allowRelayerBootstrap: true });
    expect(res.status).toBe(404);
    const row = await db.pool.query('SELECT allow_relayer_bootstrap FROM agents WHERE id = $1', [id]);
    expect(row.rows[0].allow_relayer_bootstrap).toBe(false);
  });

  it('rejects a bad body with 400 (wrong type, extra key, empty)', async () => {
    const id = await createAgent();
    for (const body of [{ allowRelayerBootstrap: 'yes' }, { allowRelayerBootstrap: true, extra: 1 }, {}]) {
      const res = await request(t.app).patch(`/api/agents/${id}/gas-policy`).set('authorization', ownerAuth(OWNER)).send(body);
      expect(res.status).toBe(400);
    }
  });
});
