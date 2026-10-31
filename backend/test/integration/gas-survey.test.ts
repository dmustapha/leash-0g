import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { buildTestApp, ownerAuth, type TestApp } from '../helpers/app.js';
import { insertChainDeployment } from '../../src/store/chain-deployments.js';
import { setAllowRelayerBootstrap } from '../../src/store/agents.js';
import type { ChainConfig } from '../../src/chain/registry.js';
import type { RuntimeChain } from '../../src/runtime/session-chain.js';
import type { OwnerChainRegistry } from '../../src/api/owner-routes.js';

/**
 * AQ-FND M-3 inc-2 — GET /api/agents/:id/gas-survey: read-only holdings per chain + the planned
 * route. Owner-only (foreign ⇒ 404); one unreadable chain ⇒ `unknown`, never zero, still 200.
 */

const HOME = 16602;
const BASE = 84532;
const OWNER = '0x' + '5a'.repeat(20);
const OTHER_OWNER = '0x' + '6b'.repeat(20);
const OPS = '0x' + '0f'.repeat(20);
const SESSION = '0x' + 'c3'.repeat(20);
const TOKEN = '0x' + 'ec'.repeat(20);
const USDC = '0x' + 'a5'.repeat(20);
const ROUTER = '0x' + 'ab'.repeat(20);

function config(chainId: number, name: string, extra: Partial<ChainConfig> = {}): ChainConfig {
  return { chainId, name, rpcUrl: 'http://unused.invalid', registryAddr: '0x' + '00'.repeat(20), accountVersion: 6, gasFloorWei: 2_000_000_000n, ...extra };
}

const CONFIGS: Record<number, ChainConfig> = {
  [HOME]: config(HOME, '0G Galileo'),
  [BASE]: config(BASE, 'Base Sepolia', { canonical: { router: ROUTER, settlementToken: USDC } }),
};

/** A readable chain: zero native, holds `tokenBalance` of every token, enabled, ops is a payee. */
function readableChain(tokenBalance: bigint): RuntimeChain {
  return {
    async getBalance() {
      return 0n;
    },
    async getErc20Balance() {
      return tokenBalance;
    },
    async getAssetPolicy(_a: string, token: string, payees: string[]) {
      const isNative = token === '0x0000000000000000000000000000000000000000';
      return { enabled: !isNative, allowedPayees: isNative ? [] : payees.map((p) => p.toLowerCase()) };
    },
  } as unknown as RuntimeChain;
}

const failingChain = {
  async getBalance(): Promise<bigint> {
    throw new Error('rpc down');
  },
} as unknown as RuntimeChain;

function fakeRegistry(sessionChains: Record<number, RuntimeChain>): OwnerChainRegistry {
  return {
    has: (id) => id in CONFIGS,
    listChains: () => Object.values(CONFIGS),
    getChainOps: () => {
      throw new Error('not used');
    },
    getChainConfig: (id) => CONFIGS[id]!,
    getGasRouteSurface: () => ({
      has: (id) => id in CONFIGS,
      getChainConfig: (id) => CONFIGS[id]!,
      getSessionChain: (id) => sessionChains[id]!,
      opsRelayerAddr: OPS,
    }),
  };
}

let db: TestDb;
let t: TestApp;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

async function seedSurveyAgent(withBase: boolean): Promise<string> {
  const id = await seedAgent(db.pool, {
    ownerAddr: OWNER,
    sessionKeyAddr: SESSION,
    chainId: HOME,
    goal: { type: 'treasury', beneficiary: '0x' + '9c'.repeat(20), token: TOKEN, targetBalanceWei: '5', topUpWei: '1' },
  });
  if (withBase) {
    const acct = (await db.pool.query<{ account_addr: string }>('SELECT account_addr FROM agents WHERE id = $1', [id])).rows[0]!.account_addr;
    await insertChainDeployment(db.pool, { agentId: id, chainId: BASE, accountAddr: acct, createTx: '0x1', registerTx: '0x2', chainAgentId: null, adopted: false });
  }
  return id;
}

function get(id: string, owner: string) {
  return request(t.app).get(`/api/agents/${id}/gas-survey`).set('authorization', ownerAuth(owner));
}

describe('GET /api/agents/:id/gas-survey (AQ-FND M-3 inc-2)', () => {
  it('owner gets holdings per chain + the planned route (strings for amounts, no txs)', async () => {
    const id = await seedSurveyAgent(true);
    t = buildTestApp(db.pool, { chainRegistry: fakeRegistry({ [HOME]: readableChain(7n), [BASE]: readableChain(9n) }) });
    const res = await get(id, OWNER);
    expect(res.status).toBe(200);
    expect(res.body.homeChainId).toBe(HOME);
    expect(res.body.allowRelayerBootstrap).toBe(false);
    expect(res.body.chains).toHaveLength(2);
    const home = res.body.chains.find((c: { chainId: number }) => c.chainId === HOME);
    expect(home).toMatchObject({ name: '0G Galileo', status: 'ok', sessionNativeWei: '0', accountNativeWei: '0' });
    expect(home.spendableTokens).toEqual([{ token: TOKEN, balance: '7' }]);
    const base = res.body.chains.find((c: { chainId: number }) => c.chainId === BASE);
    expect(base.spendableTokens).toEqual([{ token: USDC, balance: '9' }]);
    // zero native everywhere, no opt-in ⇒ an ask, with a machine-readable list of what is missing
    expect(res.body.route.mode).toBe('ask-owner');
    expect(res.body.route.legs).toEqual([]);
    expect(res.body.route.ask.surveyedChains).toEqual([HOME, BASE]);
    expect(res.body.route.ask.missing).toContain('owner opt-in for relayer bootstrap');
  });

  it('reflects the opt-in flag in the route (opt-in + delegate would allow bootstrap)', async () => {
    const id = await seedSurveyAgent(false);
    await setAllowRelayerBootstrap(db.pool, id, true);
    t = buildTestApp(db.pool, { chainRegistry: fakeRegistry({ [HOME]: readableChain(7n) }) });
    const res = await get(id, OWNER);
    expect(res.status).toBe(200);
    expect(res.body.allowRelayerBootstrap).toBe(true);
    // the home chain declares no GasRepayDelegate ⇒ still an ask, never a relayer route
    expect(res.body.route.mode).toBe('ask-owner');
  });

  it('a chain that cannot be read is `unknown` (never zero) and the endpoint still answers 200', async () => {
    const id = await seedSurveyAgent(true);
    t = buildTestApp(db.pool, { chainRegistry: fakeRegistry({ [HOME]: readableChain(7n), [BASE]: failingChain }) });
    const res = await get(id, OWNER);
    expect(res.status).toBe(200);
    const base = res.body.chains.find((c: { chainId: number }) => c.chainId === BASE);
    expect(base).toMatchObject({ status: 'unknown', sessionNativeWei: '0', spendableTokens: [] });
    expect(res.body.route.ask.unknownChains).toEqual([BASE]);
  });

  it('a foreign owner gets 404', async () => {
    const id = await seedSurveyAgent(false);
    t = buildTestApp(db.pool, { chainRegistry: fakeRegistry({ [HOME]: readableChain(7n) }) });
    const res = await get(id, OTHER_OWNER);
    expect(res.status).toBe(404);
  });

  it('no registry surface wired ⇒ 503 (never a fabricated survey)', async () => {
    const id = await seedSurveyAgent(false);
    t = buildTestApp(db.pool);
    const res = await get(id, OWNER);
    expect(res.status).toBe(503);
  });
});
