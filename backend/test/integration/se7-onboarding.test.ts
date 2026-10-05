import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { keccak256, toHex } from 'viem';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { buildTestApp, ownerAuth, type TestApp } from '../helpers/app.js';
import { getChainDeployment } from '../../src/store/chain-deployments.js';
import { UnregisteredChainError } from '../../src/chain/registry.js';
import type { OnboardChainOps, PersistedCreateTuple } from '../../src/chain/onboard.js';

/**
 * SE-7 (E-7) — SECOND-CHAIN ONBOARDING through the production owner route.
 * The persisted construction tuple + salt are replayed BYTE-EXACT so the
 * account lands at the SAME CREATE2 address; ANY tuple drift predicts a
 * different address and is REFUSED before minting (adversarial coverage per
 * the SE-6 gate carry #1). ownerAddr derives from the AUTHENTICATED SESSION
 * (L-04) on every route here.
 */

const OWNER = '0x' + '1a'.repeat(20);
const OTHER_OWNER = '0x' + '2b'.repeat(20);
const GUARDIAN = '0x' + 'ab'.repeat(20); // == FakeChainOps FAKE_GUARDIAN_ADDR
const SALT = '0x' + 'a5'.repeat(32);
const HOME_CHAIN = 16602;
const BASE_CHAIN = 84532;

const TUPLE: PersistedCreateTuple = {
  ownerAddr: OWNER,
  guardianAddr: GUARDIAN,
  sessionKeyAddr: '0x' + 'c3'.repeat(20),
  policy: { perTransferCap: '10000000000000000', windowCap: '30000000000000000', windowSeconds: 3600, expiresAt: 2_000_000_000 },
  allowlist: ['0x' + 'e5'.repeat(20)],
  timelockDelay: 900,
  settlementToken: '0x' + '00'.repeat(20),
  tokenPolicy: { perTransferCapToken: '0', windowCapToken: '0' },
};

/** The fake chain's CREATE2: a pure function of the FULL tuple + salt — any
 * drift in any field lands a different address, like the real initcode hash. */
function fakePredict(input: Record<string, unknown>): string {
  const canonical = JSON.stringify(input, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
  return `0x${keccak256(toHex(canonical)).slice(2, 42)}`;
}

class FakeOnboardOps {
  public guardianAddress = GUARDIAN;
  public mints: Array<Record<string, unknown>> = [];
  public adoptNext = false;
  async predictAccountV4(input: Record<string, unknown>): Promise<string> {
    return fakePredict({ ...input, guardianAddr: input['guardianAddr'] ?? this.guardianAddress });
  }
  public funded: Array<{ addr: string; amountWei: bigint }> = [];
  async fundSessionKey(addr: string, amountWei: bigint): Promise<{ txHash: string }> {
    this.funded.push({ addr, amountWei });
    return { txHash: '0x' + '55'.repeat(32) };
  }
  async deployAndRegister(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.mints.push(input);
    const predicted = fakePredict({
      ownerAddr: input['ownerAddr'],
      sessionKeyAddr: input['sessionKeyAddr'],
      guardianAddr: this.guardianAddress,
      policy: input['policy'],
      allowlist: input['allowlist'],
      timelockDelay: input['timelockDelay'],
      ...(input['settlementToken'] !== undefined ? { settlementToken: input['settlementToken'] } : {}),
      tokenPolicy: input['tokenPolicy'],
      accountSalt: input['accountSalt'],
    });
    return {
      accountAddr: predicted,
      chainAgentId: 7n,
      createTx: this.adoptNext ? '0x' + '00'.repeat(32) : '0x' + '77'.repeat(32),
      registerTx: '0x' + '88'.repeat(32),
      guardianAddr: this.guardianAddress,
      accountVersion: 4,
      accountSalt: input['accountSalt'],
      accountCreateTuple: null,
      adopted: this.adoptNext,
    };
  }
}

/** What the route's refusal-first predict computes for the seeded tuple. */
function expectedAccount(): string {
  return fakePredict({
    ownerAddr: TUPLE.ownerAddr,
    sessionKeyAddr: TUPLE.sessionKeyAddr,
    guardianAddr: TUPLE.guardianAddr,
    policy: {
      perTransferCap: BigInt(TUPLE.policy.perTransferCap),
      windowCap: BigInt(TUPLE.policy.windowCap),
      windowSeconds: TUPLE.policy.windowSeconds,
      expiresAt: TUPLE.policy.expiresAt,
    },
    allowlist: TUPLE.allowlist,
    timelockDelay: TUPLE.timelockDelay,
    tokenPolicy: { perTransferCapToken: 0n, windowCapToken: 0n },
    accountSalt: SALT,
  });
}

let db: TestDb;
let app: TestApp;
let baseOps: FakeOnboardOps;
let agentId: string;

let ownerSeq = 0;
/** A fresh owner per auxiliary seed — migration 021 forbids one owner holding
 * two agents at the SAME (chain, account), and every seed here deliberately
 * reuses the same-address account. */
function freshOwner(): string {
  ownerSeq += 1;
  return `0x${ownerSeq.toString(16).padStart(40, '0')}`;
}

async function seedV4Agent(opts: { ownerAddr?: string; tuple?: PersistedCreateTuple | null; salt?: string | null; version?: number } = {}): Promise<{ id: string; owner: string }> {
  const owner = opts.ownerAddr ?? freshOwner();
  const id = await seedAgent(db.pool, {
    ownerAddr: owner,
    accountAddr: expectedAccount(),
    sessionKeyAddr: TUPLE.sessionKeyAddr,
    chainId: HOME_CHAIN,
  });
  await db.pool.query(
    `UPDATE agents SET account_version = $2, account_salt = $3, account_create_tuple = $4 WHERE id = $1`,
    [id, opts.version ?? 4, opts.salt === null ? null : (opts.salt ?? SALT), opts.tuple === null ? null : JSON.stringify(opts.tuple ?? TUPLE)],
  );
  return { id, owner };
}

beforeAll(async () => {
  db = await createTestDb();
  baseOps = new FakeOnboardOps();
  app = buildTestApp(db.pool, {
    chainRegistry: {
      has: (chainId: number) => chainId === HOME_CHAIN || chainId === BASE_CHAIN,
      getChainConfig: () => ({}), // SE-8: no protocol allowlist in this fixture (unrestricted)
      listChains: () => [
        { chainId: HOME_CHAIN, name: '0G Galileo Testnet' },
        { chainId: BASE_CHAIN, name: 'Base Sepolia' },
      ],
      getChainOps: (chainId: number) => {
        if (chainId !== BASE_CHAIN && chainId !== HOME_CHAIN) throw new UnregisteredChainError(chainId);
        return baseOps as unknown as OnboardChainOps;
      },
    },
  });
  agentId = (await seedV4Agent({ ownerAddr: OWNER })).id;
});
afterAll(async () => {
  await db.drop();
});
beforeEach(() => {
  baseOps.mints = [];
  baseOps.adoptNext = false;
  baseOps.guardianAddress = GUARDIAN;
});

describe('SE-7 second-chain onboarding (persisted-tuple replay)', () => {
  it('GET /api/chains lists the registered chain table (FE chain selector)', async () => {
    const res = await request(app.ownerApp).get('/api/networks').set('Authorization', ownerAuth(OWNER));
    expect(res.status).toBe(200);
    expect(res.body.chains).toEqual([
      { chainId: HOME_CHAIN, name: '0G Galileo Testnet', capabilities: [] },
      { chainId: BASE_CHAIN, name: 'Base Sepolia', capabilities: [] },
    ]);
  });

  it('happy: onboards onto Base by replaying the EXACT persisted tuple + salt → SAME address', async () => {
    const res = await request(app.ownerApp)
      .post(`/api/agents/${agentId}/networks`)
      .set('Authorization', ownerAuth(OWNER))
      .send({ chainId: BASE_CHAIN });
    expect(res.status).toBe(201);
    expect(res.body.accountAddr).toBe(expectedAccount());
    expect(res.body.adopted).toBe(false);
    expect(res.body.alreadyOnboarded).toBe(false);
    // the mint received the byte-exact persisted material
    expect(baseOps.mints).toHaveLength(1);
    const mint = baseOps.mints[0] as Record<string, unknown>;
    expect(mint['accountSalt']).toBe(SALT);
    expect(mint['ownerAddr']).toBe(TUPLE.ownerAddr);
    expect(mint['allowlist']).toEqual(TUPLE.allowlist);
    expect(mint['timelockDelay']).toBe(TUPLE.timelockDelay);
    // presence row recorded
    const row = await getChainDeployment(db.pool, agentId, BASE_CHAIN);
    expect(row?.accountAddr).toBe(expectedAccount());
    expect(row?.adopted).toBe(false);
  });

  it('idempotent: a second onboard returns the existing row and mints NOTHING', async () => {
    const res = await request(app.ownerApp)
      .post(`/api/agents/${agentId}/networks`)
      .set('Authorization', ownerAuth(OWNER))
      .send({ chainId: BASE_CHAIN });
    expect(res.status).toBe(200);
    expect(res.body.alreadyOnboarded).toBe(true);
    expect(baseOps.mints).toHaveLength(0);
  });

  it('GET /api/agents/:id/chains lists home + onboarded presence at the same address', async () => {
    const res = await request(app.ownerApp).get(`/api/agents/${agentId}/networks`).set('Authorization', ownerAuth(OWNER));
    expect(res.status).toBe(200);
    expect(res.body.homeChainId).toBe(HOME_CHAIN);
    expect(res.body.onboardable).toBe(true);
    expect(res.body.chains).toHaveLength(2);
    expect(res.body.chains[0]).toMatchObject({ chainId: HOME_CHAIN, role: 'home', accountAddr: expectedAccount() });
    expect(res.body.chains[1]).toMatchObject({ chainId: BASE_CHAIN, role: 'onboarded', accountAddr: expectedAccount() });
  });

  it('ADVERSARIAL: a mutated persisted tuple predicts a DIFFERENT address and is REFUSED (no mint, no row)', async () => {
    const mutated = { ...TUPLE, policy: { ...TUPLE.policy, expiresAt: TUPLE.policy.expiresAt + 1 } };
    const { id, owner } = await seedV4Agent({ tuple: mutated });
    // the agent row still carries the ORIGINAL address — the mutated tuple's
    // prediction diverges from it, exactly the reconstructed-tuple drift case.
    const res = await request(app.ownerApp)
      .post(`/api/agents/${id}/networks`)
      .set('Authorization', ownerAuth(owner))
      .send({ chainId: BASE_CHAIN });
    expect(res.status).toBe(409);
    expect(res.body.error.reason).toBe('tuple_prediction_mismatch');
    expect(baseOps.mints).toHaveLength(0);
    expect(await getChainDeployment(db.pool, id, BASE_CHAIN)).toBeNull();
  });

  it('ADVERSARIAL: a mutated SALT predicts a different address and is refused', async () => {
    const { id, owner } = await seedV4Agent({ salt: '0x' + 'b6'.repeat(32) });
    const res = await request(app.ownerApp)
      .post(`/api/agents/${id}/networks`)
      .set('Authorization', ownerAuth(owner))
      .send({ chainId: BASE_CHAIN });
    expect(res.status).toBe(409);
    expect(res.body.error.reason).toBe('tuple_prediction_mismatch');
    expect(baseOps.mints).toHaveLength(0);
  });

  it('refuses when the target-chain guardian lane is NOT the create-time guardian', async () => {
    baseOps.guardianAddress = '0x' + 'cd'.repeat(20);
    const { id, owner } = await seedV4Agent();
    const res = await request(app.ownerApp)
      .post(`/api/agents/${id}/networks`)
      .set('Authorization', ownerAuth(owner))
      .send({ chainId: BASE_CHAIN });
    expect(res.status).toBe(409);
    expect(res.body.error.reason).toBe('guardian_mismatch');
    expect(baseOps.mints).toHaveLength(0);
  });

  it('default-deny: an unregistered chain is refused (E-11)', async () => {
    const res = await request(app.ownerApp)
      .post(`/api/agents/${agentId}/networks`)
      .set('Authorization', ownerAuth(OWNER))
      .send({ chainId: 421614 });
    expect(res.status).toBe(409);
    expect(res.body.error.reason).toBe('unregistered_chain');
  });

  it('refuses the home chain and non-v4 / tuple-less agents', async () => {
    const home = await request(app.ownerApp)
      .post(`/api/agents/${agentId}/networks`)
      .set('Authorization', ownerAuth(OWNER))
      .send({ chainId: HOME_CHAIN });
    expect(home.status).toBe(409);
    expect(home.body.error.reason).toBe('home_chain');

    const legacySeed = await seedV4Agent({ version: 2, salt: null, tuple: null });
    const legacy = await request(app.ownerApp)
      .post(`/api/agents/${legacySeed.id}/networks`)
      .set('Authorization', ownerAuth(legacySeed.owner))
      .send({ chainId: BASE_CHAIN });
    expect(legacy.status).toBe(409);
    expect(legacy.body.error.reason).toBe('not_v4');

    const tuplelessSeed = await seedV4Agent({ tuple: null });
    const tupleless = await request(app.ownerApp)
      .post(`/api/agents/${tuplelessSeed.id}/networks`)
      .set('Authorization', ownerAuth(tuplelessSeed.owner))
      .send({ chainId: BASE_CHAIN });
    expect(tupleless.status).toBe(409);
    expect(tupleless.body.error.reason).toBe('no_persisted_tuple');
  });

  it('authz: another owner cannot onboard or view this agent (session-derived, L-04)', async () => {
    const post = await request(app.ownerApp)
      .post(`/api/agents/${agentId}/networks`)
      .set('Authorization', ownerAuth(OTHER_OWNER))
      .send({ chainId: BASE_CHAIN });
    expect(post.status).toBe(404);
    const get = await request(app.ownerApp).get(`/api/agents/${agentId}/networks`).set('Authorization', ownerAuth(OTHER_OWNER));
    expect(get.status).toBe(404);
  });

  it('create-time chain choice (spec §7.C): POST /api/agents with chainId mints on THAT chain', async () => {
    const auditKey = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'; // valid secp256k1 point (generator)
    const body = {
      name: 'base-native agent',
      auditPubKey: auditKey,
      policy: { perTransferCapWei: '10000000000000000', windowCapWei: '30000000000000000', windowSeconds: 3600, expiresAt: Math.floor(Date.now() / 1000) + 86_400 },
      allowlist: ['0x' + '9c'.repeat(20)],
      goal: { beneficiary: '0x' + '9c'.repeat(20), targetBalanceWei: '50000000000000000', topUpWei: '5000000000000000' },
      chainId: BASE_CHAIN,
    };
    const res = await request(app.ownerApp).post('/api/agents').set('Authorization', ownerAuth(OWNER)).send(body);
    expect(res.status).toBe(201);
    expect(baseOps.mints).toHaveLength(1); // minted through BASE's ops lane
    expect(baseOps.funded).toHaveLength(1); // gas dust funded on the SAME chain
    const row = await db.pool.query<{ chain_id: string }>(`SELECT chain_id FROM agents WHERE id = $1`, [res.body.agentId]);
    expect(Number(row.rows[0]?.chain_id)).toBe(BASE_CHAIN);
  });

  it('create-time chain choice: an unregistered chainId is refused (default-deny)', async () => {
    const res = await request(app.ownerApp)
      .post('/api/agents')
      .set('Authorization', ownerAuth(OWNER))
      .send({
        name: 'x',
        auditPubKey: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
        policy: { perTransferCapWei: '1', windowCapWei: '2', windowSeconds: 3600, expiresAt: Math.floor(Date.now() / 1000) + 86_400 },
        allowlist: ['0x' + '9c'.repeat(20)],
        goal: { beneficiary: '0x' + '9c'.repeat(20), targetBalanceWei: '5', topUpWei: '1' },
        chainId: 421614,
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('unregistered_chain');
  });

  it('L-04: the per-chain account view scopes by the AUTHENTICATED owner, home + onboarded chains', async () => {
    const addr = expectedAccount();
    // home chain resolves through the agents row
    const home = await request(app.ownerApp)
      .get(`/api/networks/${HOME_CHAIN}/accounts/${addr}`)
      .set('Authorization', ownerAuth(OWNER));
    expect(home.status).toBe(200);
    expect(home.body.agent.id).toBe(agentId);
    // onboarded chain resolves through the deployment row (same address)
    const onboarded = await request(app.ownerApp)
      .get(`/api/networks/${BASE_CHAIN}/accounts/${addr}`)
      .set('Authorization', ownerAuth(OWNER));
    expect(onboarded.status).toBe(200);
    expect(onboarded.body.agent.id).toBe(agentId);
    // ANOTHER owner presenting the same address gets NOTHING — the read is
    // keyed by the session owner, never by caller-supplied text.
    const other = await request(app.ownerApp)
      .get(`/api/networks/${HOME_CHAIN}/accounts/${addr}`)
      .set('Authorization', ownerAuth(OTHER_OWNER));
    expect(other.status).toBe(404);
  });
});
