import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomBytes } from 'node:crypto';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { buildTestApp, ownerAuth, type TestApp } from '../helpers/app.js';
import type { OwnerChainRegistry } from '../../src/api/owner-routes.js';

/**
 * SE-8 carry #2 — `ChainConfig.protocolAllowlist` is CONSUMED by the owner grant
 * surface: on a chain with a configured list, a call-rule (or preset) target
 * outside `protocolAllowlist ∪ bridgeAllowlist ∪ canonical` is refused (422); a
 * chain with no configured list stays unrestricted (0G mocks today).
 */

const OWNER = '0x' + '4a'.repeat(20);
const CHAIN_WITH_LIST = 84532;
const CHAIN_NO_LIST = 16602;
const PROTOCOL = '0x' + '11'.repeat(20);
const BRIDGE = '0x4200000000000000000000000000000000000010';
const OFF_LIST = '0x' + '66'.repeat(20);
const SEL = '0x095ea7b3';

let db: TestDb;
let app: TestApp;

const registry: OwnerChainRegistry = {
  has: (id) => id === CHAIN_WITH_LIST || id === CHAIN_NO_LIST,
  listChains: () => [
    { chainId: CHAIN_NO_LIST, name: '0G Galileo Testnet' },
    { chainId: CHAIN_WITH_LIST, name: 'Base Sepolia' },
  ],
  getChainOps: () => {
    throw new Error('not needed here');
  },
  getChainConfig: (id: number) => {
    if (id === CHAIN_WITH_LIST) return { protocolAllowlist: [PROTOCOL], bridgeAllowlist: [BRIDGE] };
    if (id === CHAIN_NO_LIST) return {};
    throw new Error(`unregistered ${id}`);
  },
};

beforeAll(async () => {
  db = await createTestDb();
  app = buildTestApp(db.pool, { chainRegistry: registry });
});

afterAll(async () => {
  await db.drop();
});

async function seed(chainId: number): Promise<string> {
  return seedAgent(db.pool, {
    ownerAddr: OWNER,
    accountAddr: `0x${randomBytes(20).toString('hex')}`,
    chainId,
  });
}

function ruleBody(target: string): Record<string, unknown> {
  return {
    action: 'propose',
    txHash: '0x' + 'ab'.repeat(32),
    rule: { target, selector: SEL, recipientMode: 'self', spenderSet: [PROTOCOL], perCallCap: '100', windowCapCall: '200' },
  };
}

describe('SE-8 grant surface — protocol allowlist consumption (carry #2)', () => {
  it('REFUSES (422) an off-allowlist rule target on a chain WITH a configured list', async () => {
    const id = await seed(CHAIN_WITH_LIST);
    const res = await request(app.app)
      .post(`/api/agents/${id}/capabilities/rule`)
      .set('authorization', ownerAuth(OWNER))
      .send(ruleBody(OFF_LIST));
    expect(res.status).toBe(422);
    expect(String(res.body?.error?.message)).toContain('protocol allowlist');
  });

  it('ACCEPTS a protocol-allowlisted target AND a bridge-allowlisted target', async () => {
    const id = await seed(CHAIN_WITH_LIST);
    for (const target of [PROTOCOL, BRIDGE]) {
      const res = await request(app.app)
        .post(`/api/agents/${id}/capabilities/rule`)
        .set('authorization', ownerAuth(OWNER))
        .send(ruleBody(target));
      expect(res.status).toBe(200);
    }
  });

  it('a chain with NO configured list stays unrestricted (legacy 0G path unchanged)', async () => {
    const id = await seed(CHAIN_NO_LIST);
    const res = await request(app.app)
      .post(`/api/agents/${id}/capabilities/rule`)
      .set('authorization', ownerAuth(OWNER))
      .send(ruleBody(OFF_LIST));
    expect(res.status).toBe(200);
  });
});
