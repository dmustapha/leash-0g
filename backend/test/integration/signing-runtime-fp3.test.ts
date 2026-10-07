import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import nock from 'nock';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { buildTestApp, TEST_KEK, UPSTREAM, type TestApp } from '../helpers/app.js';
import { generateGatewayToken, hashTokenSecret } from '../../src/crypto/token.js';
import { encryptSecret } from '../../src/crypto/keycrypt.js';
import { LeashRuntimeManager } from '../../src/runtime/manager.js';
import {
  upsertSigningRule,
  listSigningArms,
  insertSigningRequest,
  setSigningRequestDecision,
} from '../../src/store/signing.js';
import { defaultSigningRegistry } from '../../src/signing/index.js';
import type { RuntimeChain, GrantStateCandidates } from '../../src/runtime/session-chain.js';
import type { GrantState } from '../../src/governed-call/index.js';
import type { PolicyView } from '../../src/types.js';

/**
 * Stage F′ FP-3 — the runtime governed-signing decide node. An agent emits a `sign` intent → the
 * decide node builds the intent from the owner's signing grant (never-guess-money), classifies L1
 * (in policy), and ARMS it on-chain via the scoped session key → records `signing_arms` armed. This
 * proves the FP-3 done-criterion: L1 classify → session-key authorizeSigningIntent → arm recorded.
 */

const OWNER = '0x' + '4b'.repeat(20);
const BENEFICIARY = '0x' + '9c'.repeat(20);
const SESSION_PK = '0x' + '6d'.repeat(32);
const SPENDER = '0x' + 'b2'.repeat(20);
const TOKEN = '0x' + 'a1'.repeat(20);
const CAP = 10n ** 16n;
const DESC_ID = 1; // the built-in erc2612.permit (flat, not sensitive → L1-armable)

class FakeSigningChain implements RuntimeChain {
  public balances = new Map<string, bigint>();
  public arms: Array<{ descriptorId: number; fields: string[]; digest: string }> = [];
  public policyView: PolicyView = {
    perTransferCap: CAP,
    windowCap: 3n * CAP,
    windowSeconds: 3600,
    expiresAt: Math.floor(Date.now() / 1000) + 86_400,
    allowlist: [BENEFICIARY],
    revoked: false,
    spentInWindow: 0n,
    windowStart: Math.floor(Date.now() / 1000),
  };

  async getBalance(addr: string): Promise<bigint> {
    return this.balances.get(addr.toLowerCase()) ?? 0n;
  }
  async getPolicyView(): Promise<PolicyView> {
    return this.policyView;
  }
  async executeTransfer(): Promise<{ txHash: string }> {
    return { txHash: '0x' + 'ee'.repeat(32) };
  }
  async executeTokenTransfer(): Promise<{ txHash: string }> {
    return { txHash: '0x' + 'dd'.repeat(32) };
  }
  async executeCall(): Promise<{ txHash: string }> {
    return { txHash: '0x' + 'cc'.repeat(32) };
  }
  async getErc20Balance(): Promise<bigint> {
    return 0n;
  }
  async getErc20Allowance(): Promise<bigint> {
    return 0n;
  }
  async getSwapBandPrice18(): Promise<bigint | null> {
    return null;
  }
  async getErc20Meta(): Promise<{ symbol: string; decimals: number }> {
    return { symbol: '0G', decimals: 18 };
  }
  async readCallGrantState(_c: GrantStateCandidates): Promise<GrantState> {
    return { rules: new Map(), budgets: new Map(), allowlist: new Set() };
  }
  async authorizeSigningIntent(input: {
    descriptorId: number;
    fields: string[];
    digest: string;
  }): Promise<{ txHash: string; digest: string; epoch: number }> {
    this.arms.push({ descriptorId: input.descriptorId, fields: input.fields, digest: input.digest });
    return { txHash: '0x' + 'a5'.repeat(32), digest: input.digest, epoch: 1 };
  }
}

let db: TestDb;
let t: TestApp;
let server: Server;
let gatewayUrl: string;
let checkpointer: PostgresSaver;
let fakeChain: FakeSigningChain;
let manager: LeashRuntimeManager;
const startedAgents: string[] = [];

beforeAll(async () => {
  db = await createTestDb();
  checkpointer = new PostgresSaver(db.pool, undefined, { schema: db.schema });
  await checkpointer.setup();
  t = buildTestApp(db.pool);
  server = t.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no server address');
  gatewayUrl = `http://127.0.0.1:${addr.port}`;
  nock.disableNetConnect();
  nock.enableNetConnect(/127\.0\.0\.1|localhost|neon\.tech/);
});

beforeEach(() => {
  fakeChain = new FakeSigningChain();
  manager = new LeashRuntimeManager({
    pool: db.pool,
    hub: t.hub,
    broker: t.broker,
    chain: fakeChain,
    checkpointer,
    alerts: t.alerts,
    settings: {
      keyEncryptionSecret: TEST_KEK,
      approvalTimeoutMs: 20_000,
      gatewayUrl,
      intervalMs: 3_600_000,
      defaultModel: 'test-model',
      jitTtlMs: 600_000,
    },
  });
});

afterEach(async () => {
  for (const id of startedAgents.splice(0)) await manager.stop(id);
  nock.cleanAll();
});

afterAll(async () => {
  nock.enableNetConnect();
  await new Promise((resolve) => server.close(resolve));
  await db.drop();
});

async function seedRuntimeAgent(): Promise<string> {
  const gen = generateGatewayToken();
  const account = `0x${randomBytes(20).toString('hex')}`;
  fakeChain.balances.set(account.toLowerCase(), 10n ** 18n);
  return seedAgent(db.pool, {
    ownerAddr: OWNER,
    accountAddr: account,
    tokenId: gen.tokenId,
    tokenHash: await hashTokenSecret(gen.secret),
    sessionKeyEnc: encryptSecret(SESSION_PK, TEST_KEK),
    gatewayTokenEnc: encryptSecret(gen.token, TEST_KEK),
    goal: {
      beneficiary: BENEFICIARY,
      targetBalanceWei: (50n * CAP).toString(),
      topUpWei: (CAP / 2n).toString(),
      model: 'test-model',
    },
  });
}

async function seedSigningGrant(agentId: string): Promise<void> {
  const descriptor = defaultSigningRegistry.get(DESC_ID)!;
  await upsertSigningRule(db.pool, {
    agentId,
    ownerAddr: OWNER,
    descriptorKey: descriptor.key,
    rule: {
      descriptorId: DESC_ID,
      spenderSet: [SPENDER.toLowerCase()],
      perIntentCap: '1000',
      maxDeadlineWindow: 3600,
      token: TOKEN,
      active: true,
    },
    source: 'custom',
    status: 'active',
  });
}

function mockModelDecision(content: string): void {
  nock(UPSTREAM)
    .post('/v1/chat/completions')
    .reply(200, {
      id: 'cmpl-s',
      choices: [{ message: { role: 'assistant', content } }],
      x_0g_trace: { provider: '0xprov', request_id: 'req-s', billing: { total: 1 } },
    });
}

async function start(agentId: string): Promise<void> {
  await manager.start(agentId);
  startedAgents.push(agentId);
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('runtime governed-signing action (FP-3)', () => {
  it('L1 in-policy: builds the intent, arms via the session key, records signing_arms=armed', async () => {
    const id = await seedRuntimeAgent();
    await seedSigningGrant(id);
    mockModelDecision(
      JSON.stringify({ action: 'sign', descriptorId: DESC_ID, signSpender: SPENDER, amountWei: '100', reason: 'permit the router' }),
    );

    await start(id);
    await waitFor(() => fakeChain.arms.length === 1);
    await manager.settle(id);

    const arm = fakeChain.arms[0];
    if (!arm) throw new Error('expected a session-key arm');
    expect(arm.descriptorId).toBe(DESC_ID);
    expect(arm.fields.length).toBe(5); // flat ERC-2612: owner, spender, value, nonce, deadline
    expect(arm.digest).toMatch(/^0x[0-9a-f]{64}$/);

    // the read-model recorded the arm as armed with the on-chain epoch snapshot.
    const arms = await listSigningArms(db.pool, id);
    expect(arms.length).toBe(1);
    expect(arms[0]!.status).toBe('armed');
    expect(arms[0]!.descriptorId).toBe(DESC_ID);
    expect(arms[0]!.digest).toBe(arm.digest);
    expect(arms[0]!.epoch).toBe(1);
  });

  it('out-of-grant (over cap): classifies L3-widen, stands down, never arms', async () => {
    const id = await seedRuntimeAgent();
    await seedSigningGrant(id);
    mockModelDecision(
      JSON.stringify({ action: 'sign', descriptorId: DESC_ID, signSpender: SPENDER, amountWei: '999999', reason: 'too big' }),
    );

    await start(id);
    await manager.settle(id);
    // give the cycle a beat; no arm must ever be submitted.
    await new Promise((r) => setTimeout(r, 300));
    expect(fakeChain.arms.length).toBe(0);
    const arms = await listSigningArms(db.pool, id);
    expect(arms.length).toBe(0);
  });

  it('L2 consent -> arm: an approved sensitive request arms via the session key + records armed', async () => {
    const id = await seedRuntimeAgent();
    await seedSigningGrant(id);
    // quarantined held intent (as decideSign would raise it on a sensitive descriptor).
    const digest = '0x' + 'ab'.repeat(32);
    const { row } = await insertSigningRequest(db.pool, {
      agentId: id,
      ownerAddr: OWNER,
      descriptorId: DESC_ID,
      decoded: { spender: SPENDER, amountWei: '100', deadlineSec: 1_700_003_600 },
      triggers: ['sensitive'],
      requestHash: '0x' + 'cd'.repeat(32),
      intent: { descriptorId: DESC_ID, fields: Array(5).fill('0x' + '0'.repeat(64)), digest },
    });
    await setSigningRequestDecision(db.pool, row.id, 'approved_once');

    // the manager arms the held intent on-chain (the owner-route fires this on approval).
    await manager.armApprovedSigning(id, row.id);

    expect(fakeChain.arms.length).toBe(1);
    expect(fakeChain.arms[0]!.digest).toBe(digest);
    const arms = await listSigningArms(db.pool, id);
    expect(arms.length).toBe(1);
    expect(arms[0]!.status).toBe('armed');
    expect(arms[0]!.descriptorId).toBe(DESC_ID);
  });

  it('unknown descriptor: forbidden floor, stands down, never arms', async () => {
    const id = await seedRuntimeAgent();
    await seedSigningGrant(id);
    mockModelDecision(
      JSON.stringify({ action: 'sign', descriptorId: 98765, signSpender: SPENDER, amountWei: '100', reason: 'unknown' }),
    );

    await start(id);
    await manager.settle(id);
    await new Promise((r) => setTimeout(r, 300));
    expect(fakeChain.arms.length).toBe(0);
  });
});
