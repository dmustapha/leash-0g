import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { Server } from 'node:http';
import request from 'supertest';
import nock from 'nock';
import { MemorySaver } from '@langchain/langgraph';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { buildTestApp, ownerAuth, TEST_KEK, UPSTREAM, type TestApp } from '../helpers/app.js';
import { generateGatewayToken, hashTokenSecret } from '../../src/crypto/token.js';
import { encryptSecret } from '../../src/crypto/keycrypt.js';
import { LeashRuntimeManager } from '../../src/runtime/manager.js';
import { DelegationCoordinator } from '../../src/coordination/coordinator.js';
import { createLink } from '../../src/coordination/store.js';
import { upsertJobSpec } from '../../src/store/job-specs.js';
import { getJob, listJobsForOwner } from '../../src/store/jobs.js';
import { listOwnerRecords } from '../../src/store/owner-records.js';
import { PrivateKey } from 'eciesjs';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import type { RuntimeChain } from '../../src/runtime/session-chain.js';
import type { AgentGoal, PolicyView } from '../../src/types.js';
import type { StorageUploader } from '../../src/audit/batcher.js';

/**
 * Phase-4 ACP job runtime (spec §3b/§3c/§3d): the full request → deliver →
 * verify → settle lifecycle across three autonomous agents under LEASH
 * governance, plus the layered-gate blocking cases (each layer alone stops
 * release, D-JOB-3) and the governed ERC-20 settlement + multi-party PoA (F7).
 */

const OWNER = '0x' + '5a'.repeat(20);
const FEE_RECIPIENT = '0x' + '9c'.repeat(20);
const TOKEN = '0x' + '77'.repeat(20);
const FEE = (5n * 10n ** 6n).toString(); // 5 TestUSD (6dp)
const SESSION_PK = ('0x' + '7e'.repeat(32)) as Hex;
const SESSION_ADDR = privateKeyToAccount(SESSION_PK).address.toLowerCase();

// A generic deliverable-quality rule set (F2 — not prediction-specific).
const ACCEPTANCE = {
  label: 'market-analysis-floor',
  rules: [
    { kind: 'required' as const, path: 'probability' },
    { kind: 'numberRange' as const, path: 'probability', min: 0, max: 1 },
    { kind: 'required' as const, path: 'rationale' },
    { kind: 'stringLength' as const, path: 'rationale', min: 1 },
  ],
};
const JOB_SPEC = {
  question: 'Will ETH close above $4000 this month?',
  deliverableSchemaRef: 'market-probability@v1',
  acceptanceRef: 'market-analysis-floor',
};

class FakeChain implements RuntimeChain {
  public tokenTransfers: Array<{ token: string; to: string; amountWei: bigint; sessionPrivateKey: string }> = [];
  public failToken: string | null = null;
  async getBalance(): Promise<bigint> {
    return 10n ** 18n;
  }
  async getPolicyView(): Promise<PolicyView> {
    return {
      perTransferCap: 0n,
      windowCap: 0n,
      windowSeconds: 0,
      expiresAt: Math.floor(Date.now() / 1000) + 86_400,
      allowlist: [FEE_RECIPIENT],
      revoked: false,
      spentInWindow: 0n,
      windowStart: Math.floor(Date.now() / 1000),
    };
  }
  async executeTransfer(): Promise<{ txHash: string }> {
    throw new Error('native transfer not used in job settlement');
  }
  async executeTokenTransfer(input: {
    sessionPrivateKey: string;
    accountAddr: string;
    token: string;
    to: string;
    amountWei: bigint;
  }): Promise<{ txHash: string }> {
    if (this.failToken) {
      const m = this.failToken;
      this.failToken = null;
      throw new Error(m);
    }
    this.tokenTransfers.push({
      token: input.token,
      to: input.to,
      amountWei: input.amountWei,
      sessionPrivateKey: input.sessionPrivateKey,
    });
    return { txHash: '0x' + 'dd'.repeat(32) };
  }
}

class FakeUploader implements StorageUploader {
  public uploads: Buffer[] = [];
  private n = 0;
  async upload(data: Buffer): Promise<{ root: string; txHash: string }> {
    this.uploads.push(data);
    this.n += 1;
    const root = '0x' + this.n.toString(16).padStart(64, '0');
    return { root, txHash: '0x' + 'ab'.repeat(32) };
  }
}

let db: TestDb;
let t: TestApp;
let server: Server;
let gatewayUrl: string;
let checkpointer: MemorySaver;
let chain: FakeChain;
let uploader: FakeUploader;
let manager: LeashRuntimeManager;
let coordinator: DelegationCoordinator;
const started: string[] = [];
let seedSeq = 0;

beforeAll(async () => {
  db = await createTestDb();
  // In-memory checkpointer: keeps the LangGraph super-step writes off Neon so
  // the 3-agent poll cascade advances fast. The jobs projection, coordination,
  // traces, and owner records still exercise the real DB.
  checkpointer = new MemorySaver();
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
  chain = new FakeChain();
  uploader = new FakeUploader();
  manager = new LeashRuntimeManager({
    pool: db.pool,
    hub: t.hub,
    broker: t.broker,
    chain,
    uploader,
    checkpointer,
    settings: {
      keyEncryptionSecret: TEST_KEK,
      approvalTimeoutMs: 20_000,
      gatewayUrl,
      // Small poll interval: the ACP cascade advances envelope-by-envelope as
      // each role re-polls (nudge is only a latency optimization, not required).
      intervalMs: 100,
      defaultModel: 'provider-model',
    },
  });
  coordinator = new DelegationCoordinator({
    pool: db.pool,
    hub: t.hub,
    runtime: manager,
    settings: {
      delegationTtlMs: 600_000,
      delegationRatePerLinkPerHour: 100,
      delegationMaxPendingPerLink: 10,
      delegationPayloadMaxBytes: 65_536,
    },
  });
  manager.setCoordinator(coordinator);
});

afterEach(async () => {
  for (const id of started.splice(0)) await manager.stop(id);
  nock.cleanAll();
});

afterAll(async () => {
  nock.enableNetConnect();
  await new Promise((resolve) => server.close(resolve));
  await db.drop();
});

async function seedRole(goal: AgentGoal, name: string): Promise<string> {
  seedSeq += 1;
  const suffix = seedSeq.toString(16).padStart(4, '0');
  const gen = generateGatewayToken();
  return seedAgent(db.pool, {
    ownerAddr: OWNER,
    accountAddr: `0x${'ac'.repeat(18)}${suffix}`,
    sessionKeyAddr: SESSION_ADDR,
    tokenId: gen.tokenId,
    tokenHash: await hashTokenSecret(gen.secret),
    sessionKeyEnc: encryptSecret(SESSION_PK, TEST_KEK),
    gatewayTokenEnc: encryptSecret(gen.token, TEST_KEK),
    auditPubkey: new PrivateKey().publicKey.toHex(), // valid curve point for ECIES
    goal: goal as unknown as Record<string, unknown>,
    name,
  });
}

/** Wire the full ACP triangle (requester hub + provider + evaluator) and links. */
async function seedTriangle(): Promise<{ requester: string; provider: string; evaluator: string }> {
  const provider = await seedRole({ type: 'provider', serviceSpec: 'market probability analysis', model: 'provider-model' }, 'provider');
  const evaluator = await seedRole({ type: 'evaluator', rubricRef: 'strict-calibration', model: 'evaluator-model' }, 'evaluator');
  const requester = await seedRole(
    {
      type: 'requester',
      jobSpecSource: 'eth-4000',
      providerAgentId: provider,
      evaluatorAgentId: evaluator,
      feeToken: TOKEN,
      feeRecipient: FEE_RECIPIENT,
      feeCapPerJobWei: (10n * 10n ** 6n).toString(),
      model: 'requester-model',
    },
    'requester',
  );
  // F6 topology: requester↔provider, requester↔evaluator (hub); no provider↔evaluator.
  for (const [from, to] of [
    [requester, provider],
    [provider, requester],
    [requester, evaluator],
    [evaluator, requester],
  ] as const) {
    await createLink(db.pool, { ownerAddr: OWNER, fromAgentId: from, toAgentId: to, mode: 'auto' });
  }
  await upsertJobSpec(db.pool, OWNER, 'eth-4000', { spec: JOB_SPEC, acceptance: ACCEPTANCE, feeAmountWei: FEE });
  return { requester, provider, evaluator };
}

/** Route gateway inference: the evaluator (skeptic system prompt) vs the provider. */
function mockInference(deliverable: unknown, verdict: unknown): void {
  nock(UPSTREAM)
    .post('/v1/chat/completions')
    .times(20)
    .reply(200, (_uri, body: unknown) => {
      const messages = (body as { messages?: Array<{ content?: string }> }).messages ?? [];
      const system = messages[0]?.content ?? '';
      const isEvaluator = system.includes('EVALUATOR');
      const content = JSON.stringify(isEvaluator ? verdict : deliverable);
      return {
        id: 'cmpl-j',
        choices: [{ message: { role: 'assistant', content } }],
        x_0g_trace: { provider: '0xprov', request_id: 'req-j', billing: { total: 1 } },
      };
    });
}

async function startAll(ids: string[]): Promise<void> {
  for (const id of ids) {
    await manager.start(id);
    started.push(id);
  }
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function pendingSettlementApproval(requester: string): Promise<string> {
  let approvalId = '';
  await waitFor(async () => {
    const rows = await db.pool.query<{ id: string }>(
      `SELECT id FROM approvals WHERE agent_id = $1 AND state = 'pending'`,
      [requester],
    );
    approvalId = rows.rows[0]?.id ?? '';
    return approvalId !== '';
  });
  return approvalId;
}

describe('ACP job runtime — full lifecycle', () => {
  it('request → deliver → accept → owner approve → governed ERC-20 settle + PoA', { timeout: 200_000 }, async () => {
    const { requester, provider, evaluator } = await seedTriangle();
    mockInference({ probability: 0.62, rationale: 'ETH momentum + ETF flows support a >50% close' }, { verdict: 'accept', rationale: 'well calibrated' });

    await startAll([provider, evaluator, requester]);
    const approvalId = await pendingSettlementApproval(requester);

    // The layered gate reached the owner ONLY after floor + evaluator passed.
    expect(chain.tokenTransfers).toHaveLength(0);

    const res = await request(t.app)
      .post(`/api/approvals/${approvalId}`)
      .set('authorization', ownerAuth(OWNER))
      .send({ decision: 'approve', reason: 'looks good' });
    expect(res.status).toBe(200);

    await waitFor(() => chain.tokenTransfers.length === 1);
    await manager.settle(requester);

    const settle = chain.tokenTransfers[0];
    expect(settle?.token).toBe(TOKEN);
    expect(settle?.to).toBe(FEE_RECIPIENT);
    expect(settle?.amountWei).toBe(BigInt(FEE)); // fee from server state (F4), not model text
    expect(settle?.sessionPrivateKey).toBe(SESSION_PK);

    const jobs = await listJobsForOwner(db.pool, OWNER);
    const job = jobs[0];
    expect(job?.status).toBe('settled');
    expect(job?.settlementTx).toBe('0x' + 'dd'.repeat(32));
    // Multi-party PoA: each party attested its own step (F7).
    expect(job?.poa?.requesterSig).toBeTruthy();
    expect(job?.poa?.providerSig).toBeTruthy();
    expect(job?.poa?.evaluatorSig).toBeTruthy();
    expect(job?.poa?.settlementTx).toBe('0x' + 'dd'.repeat(32));

    // The signed PoA is on the owner-record / audit stream (→ 0G Storage).
    const records = await listOwnerRecords(db.pool, OWNER);
    expect(records.some((r) => r.kind === 'poa')).toBe(true);
    // Deliverable + rationale were both written to 0G Storage (owner-only).
    expect(uploader.uploads.length).toBeGreaterThanOrEqual(2);
    void provider;
    void evaluator;
  });

  it('acceptance floor blocks a malformed deliverable — no evaluation, no settlement (layer 1)', { timeout: 200_000 }, async () => {
    const { requester, provider, evaluator } = await seedTriangle();
    // probability out of range → the deterministic floor fails (no LLM can rescue it).
    mockInference({ probability: 9.9, rationale: 'nonsense' }, { verdict: 'accept', rationale: 'should never be asked' });

    await startAll([provider, evaluator, requester]);
    await waitFor(async () => {
      const jobs = await listJobsForOwner(db.pool, OWNER);
      return jobs[0]?.status === 'rejected';
    });
    await manager.settle(requester);

    const job = (await listJobsForOwner(db.pool, OWNER))[0];
    expect(job?.status).toBe('rejected');
    expect(job?.blockedBy).toBe('acceptance');
    expect(job?.verdict).toBeNull(); // evaluator never solicited
    expect(chain.tokenTransfers).toHaveLength(0);
    void provider;
    void evaluator;
  });

  it('evaluator reject blocks settlement even when the floor passes (layer 2)', { timeout: 200_000 }, async () => {
    const { requester, provider, evaluator } = await seedTriangle();
    mockInference({ probability: 0.62, rationale: 'plausible-looking but wrong' }, { verdict: 'reject', rationale: 'the reasoning does not support the number' });

    await startAll([provider, evaluator, requester]);
    await waitFor(async () => {
      const jobs = await listJobsForOwner(db.pool, OWNER);
      return jobs[0]?.status === 'rejected';
    });
    await manager.settle(requester);

    const job = (await listJobsForOwner(db.pool, OWNER))[0];
    expect(job?.status).toBe('rejected');
    expect(job?.blockedBy).toBe('verdict');
    expect(job?.acceptance?.passed).toBe(true); // floor passed; the skeptic caught it
    expect(chain.tokenTransfers).toHaveLength(0);
    void provider;
    void evaluator;
  });

  it('owner deny blocks settlement (layer 3)', { timeout: 200_000 }, async () => {
    const { requester, provider, evaluator } = await seedTriangle();
    mockInference({ probability: 0.62, rationale: 'sound' }, { verdict: 'accept', rationale: 'fine' });

    await startAll([provider, evaluator, requester]);
    const approvalId = await pendingSettlementApproval(requester);
    const res = await request(t.app)
      .post(`/api/approvals/${approvalId}`)
      .set('authorization', ownerAuth(OWNER))
      .send({ decision: 'deny', reason: 'not now' });
    expect(res.status).toBe(200);

    await waitFor(async () => {
      const jobId = (await listJobsForOwner(db.pool, OWNER))[0]?.jobId;
      return jobId ? (await getJob(db.pool, jobId))?.status === 'denied' : false;
    });
    await manager.settle(requester);

    const job = (await listJobsForOwner(db.pool, OWNER))[0];
    expect(job?.status).toBe('denied');
    expect(chain.tokenTransfers).toHaveLength(0);
    void provider;
    void evaluator;
  });
});
