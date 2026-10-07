import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MemorySaver } from '@langchain/langgraph';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { buildJobGraph, type JobGraphDeps, type JobAgentContext } from '../../src/jobs/graph.js';
import { SseHub } from '../../src/sse/hub.js';
import { createJob, recordDelivery, markEvaluating, getJob } from '../../src/store/jobs.js';
import { getAgentById } from '../../src/store/agents.js';
import { signWithSessionKey, verdictMessage } from '../../src/jobs/poa.js';
import type { RuntimeChain } from '../../src/runtime/session-chain.js';
import type { StorageUploader } from '../../src/audit/batcher.js';
import type { GrantState } from '../../src/governed-call/index.js';
import { type PolicyView, type AgentGoal, assertNativeAgent } from '../../src/types.js';

/**
 * SF-0 / L-01 closure — D-12 on the verdict surface (F-0a/F-0b/F-0c).
 *
 * Drives the REAL job graph's verdictGate against a job parked in `evaluating`,
 * and proves the money-authority spine fails CLOSED on every forged/replayed/
 * cross-job/wrong-evaluator verdict: no approval card is raised, the job is
 * rejected, and no settlement can follow. A genuine verdict from the bound
 * evaluator still reaches the owner-approval gate (no false-positive).
 *
 * Before this slice, verdictGate STORED evaluatorSig but never verified it
 * (verifyPoa existed but was uncalled) — this suite is the regression wall.
 */

const OWNER = '0x' + '5a'.repeat(20);
const TOKEN = ('0x' + '77'.repeat(20)) as Hex;
const FEE_RECIPIENT = ('0x' + '9c'.repeat(20)) as Hex;
const FEE = (5n * 10n ** 6n).toString();

// DISTINCT session keys per role — a shared key would mask a wrong-signer bug.
const REQ_PK = ('0x' + '71'.repeat(32)) as Hex;
const PROV_PK = ('0x' + '72'.repeat(32)) as Hex;
const EVAL_PK = ('0x' + '73'.repeat(32)) as Hex;
const ATTACKER_PK = ('0x' + '74'.repeat(32)) as Hex;

const reqAddr = privateKeyToAccount(REQ_PK).address.toLowerCase();
const provAddr = privateKeyToAccount(PROV_PK).address.toLowerCase();
const evalAddr = privateKeyToAccount(EVAL_PK).address.toLowerCase();

const DELIVERABLE_ROOT = ('0x' + 'cd'.repeat(32)) as Hex;
const RATIONALE_REF = ('0x' + '00'.repeat(32)) as Hex;
const JOB_SPEC = { question: 'Will ETH close above $4000?', deliverableSchemaRef: 'd@v1', acceptanceRef: 'floor' };

class FakeChain implements RuntimeChain {
  public transfers: Array<{ token: string; to: string; amountWei: bigint }> = [];
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
    throw new Error('native transfer not used');
  }
  async executeTokenTransfer(input: { token: string; to: string; amountWei: bigint }): Promise<{ txHash: string }> {
    this.transfers.push({ token: input.token, to: input.to, amountWei: input.amountWei });
    return { txHash: '0x' + 'dd'.repeat(32) };
  }
  async executeCall(): Promise<{ txHash: string }> {
    return { txHash: '0x' + 'cc'.repeat(32) };
  }
  async getErc20Meta(): Promise<{ symbol: string; decimals: number }> {
    return { symbol: 'TUSD', decimals: 6 };
  }
  async readCallGrantState(): Promise<GrantState> {
    return { rules: new Map(), budgets: new Map(), allowlist: new Set() };
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
}

class FakeUploader implements StorageUploader {
  async upload(): Promise<{ root: string; txHash: string }> {
    return { root: '0x' + '01'.repeat(32), txHash: '0x' + 'ab'.repeat(32) };
  }
}

let db: TestDb;
let hub: SseHub;
let chain: FakeChain;
let requesterId: string;
let providerId: string;
let evaluatorId: string;

async function seedRole(sessionKeyAddr: string, goal: AgentGoal, name: string): Promise<string> {
  return seedAgent(db.pool, {
    ownerAddr: OWNER,
    sessionKeyAddr,
    auditPubkey: '02' + 'd4'.repeat(32),
    goal: goal as unknown as Record<string, unknown>,
    name,
  });
}

beforeAll(async () => {
  db = await createTestDb();
  hub = new SseHub();
  providerId = await seedRole(provAddr, { type: 'provider', serviceSpec: 's' }, 'provider');
  evaluatorId = await seedRole(evalAddr, { type: 'evaluator', rubricRef: 'r' }, 'evaluator');
  requesterId = await seedRole(
    reqAddr,
    {
      type: 'requester',
      jobSpecSource: 'eth-4000',
      providerAgentId: providerId,
      evaluatorAgentId: evaluatorId,
      feeToken: TOKEN,
      feeRecipient: FEE_RECIPIENT,
      feeCapPerJobWei: (10n * 10n ** 6n).toString(),
    },
    'requester',
  );
});

afterAll(async () => {
  await db.drop();
});

/** Seed a job parked in `evaluating` with genuine requester+provider sigs. */
async function evaluatingJob(): Promise<string> {
  const jobId = randomUUID();
  const jobSpecHash = ('0x' + 'ab'.repeat(32)) as Hex;
  const requesterSig = await signWithSessionKey(REQ_PK, jobSpecHash);
  const providerSig = await signWithSessionKey(PROV_PK, DELIVERABLE_ROOT);
  await createJob(db.pool, {
    jobId,
    ownerAddr: OWNER,
    requesterAgentId: requesterId,
    providerAgentId: providerId,
    evaluatorAgentId: evaluatorId,
    spec: JOB_SPEC,
    jobSpecHash,
    requesterSig,
    feeToken: TOKEN,
    feeAmountWei: FEE,
    feeRecipient: FEE_RECIPIENT,
    feeTokenSymbol: 'TUSD',
    feeTokenDecimals: 6,
  });
  await recordDelivery(db.pool, jobId, {
    deliverable: { probability: 0.6, rationale: 'well supported' },
    deliverableRoot: DELIVERABLE_ROOT,
    deliverableSummary: 'summary',
    providerSig,
    acceptance: { passed: true, failures: [], checked: 3 },
    status: 'delivered',
  });
  await markEvaluating(db.pool, jobId);
  return jobId;
}

async function buildRequesterGraph() {
  const reqRow = await getAgentById(db.pool, requesterId);
  if (!reqRow) throw new Error('requester row missing');
  assertNativeAgent(reqRow); // SF-2: job roles are native
  chain = new FakeChain();
  const deps: JobGraphDeps = {
    pool: db.pool,
    hub,
    chain,
    uploader: new FakeUploader(),
    gatewayUrl: 'http://127.0.0.1:1',
    defaultModel: 'm',
    providerModel: 'pm',
    evaluatorModel: 'em',
  };
  const ctx: JobAgentContext = {
    agentId: requesterId,
    accountAddr: reqRow.accountAddr,
    goal: reqRow.goal,
    agentRow: reqRow,
    sessionPrivateKey: REQ_PK,
    gatewayToken: 'tok',
  };
  return buildJobGraph(deps, ctx, new MemorySaver());
}

async function driveVerdict(
  jobId: string,
  opts: { evaluatorSig: string; verdict?: 'accept' | 'reject'; fromAgentId?: string },
): Promise<void> {
  const graph = await buildRequesterGraph();
  await graph.invoke(
    {
      inboundDelegation: {
        delegationId: randomUUID(),
        kind: 'job.verdict',
        payload: { jobId, verdict: opts.verdict ?? 'accept', rationaleRef: RATIONALE_REF, evaluatorSig: opts.evaluatorSig },
        fromAgentId: opts.fromAgentId ?? evaluatorId,
      },
    },
    { configurable: { thread_id: jobId } },
  );
}

async function pendingApprovalCount(jobId: string): Promise<number> {
  const r = await db.pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM approvals WHERE agent_id = $1 AND (request_ref->>'jobId') = $2`,
    [requesterId, jobId],
  );
  return Number(r.rows[0]?.n ?? '0');
}

describe('SF-0 verdictGate — L-01 closure (F-0a/F-0b/F-0c)', () => {
  it('F-0a happy: a genuine evaluator verdict reaches the owner-approval gate', async () => {
    const jobId = await evaluatingJob();
    const sig = await signWithSessionKey(EVAL_PK, verdictMessage(jobId, 'accept', DELIVERABLE_ROOT));
    await driveVerdict(jobId, { evaluatorSig: sig });
    expect((await getJob(db.pool, jobId))?.status).toBe('awaiting_approval');
    expect(await pendingApprovalCount(jobId)).toBe(1);
    expect(chain.transfers).toHaveLength(0); // approval still pending — no settle yet
  });

  it('F-0a forged: a verdict signed by a non-party key is refused (no approval)', async () => {
    const jobId = await evaluatingJob();
    const sig = await signWithSessionKey(ATTACKER_PK, verdictMessage(jobId, 'accept', DELIVERABLE_ROOT));
    await driveVerdict(jobId, { evaluatorSig: sig });
    expect((await getJob(db.pool, jobId))?.status).toBe('rejected');
    expect(await pendingApprovalCount(jobId)).toBe(0);
  });

  it('F-0a wrong-signer: a verdict signed by the provider key is refused', async () => {
    const jobId = await evaluatingJob();
    const sig = await signWithSessionKey(PROV_PK, verdictMessage(jobId, 'accept', DELIVERABLE_ROOT));
    await driveVerdict(jobId, { evaluatorSig: sig });
    expect((await getJob(db.pool, jobId))?.status).toBe('rejected');
    expect(await pendingApprovalCount(jobId)).toBe(0);
  });

  it('F-0a garbage: an unrecoverable signature is refused', async () => {
    const jobId = await evaluatingJob();
    await driveVerdict(jobId, { evaluatorSig: '0x' + 'ff'.repeat(65) });
    expect((await getJob(db.pool, jobId))?.status).toBe('rejected');
    expect(await pendingApprovalCount(jobId)).toBe(0);
  });

  it('F-0a payload-tamper: evaluator signed "reject" but payload claims "accept" — refused', async () => {
    const jobId = await evaluatingJob();
    const sig = await signWithSessionKey(EVAL_PK, verdictMessage(jobId, 'reject', DELIVERABLE_ROOT));
    await driveVerdict(jobId, { evaluatorSig: sig, verdict: 'accept' });
    expect((await getJob(db.pool, jobId))?.status).toBe('rejected');
    expect(await pendingApprovalCount(jobId)).toBe(0);
  });

  it('F-0c cross-job replay: a verdict sig bound to another jobId is refused', async () => {
    const jobId = await evaluatingJob();
    const sig = await signWithSessionKey(EVAL_PK, verdictMessage('a-different-job-id', 'accept', DELIVERABLE_ROOT));
    await driveVerdict(jobId, { evaluatorSig: sig });
    expect((await getJob(db.pool, jobId))?.status).toBe('rejected');
    expect(await pendingApprovalCount(jobId)).toBe(0);
  });

  it('F-0b wrong-evaluator: a valid-looking verdict from a non-evaluator sender is refused', async () => {
    const jobId = await evaluatingJob();
    // Sign with the evaluator key (so the SIGNATURE is valid) but deliver it as if
    // sent by the provider agent — sender-identity must still reject it.
    const sig = await signWithSessionKey(EVAL_PK, verdictMessage(jobId, 'accept', DELIVERABLE_ROOT));
    await driveVerdict(jobId, { evaluatorSig: sig, fromAgentId: providerId });
    expect((await getJob(db.pool, jobId))?.status).toBe('rejected');
    expect(await pendingApprovalCount(jobId)).toBe(0);
  });

  it('F-0b absent-sender: a verdict with no bound sender is refused', async () => {
    const jobId = await evaluatingJob();
    const sig = await signWithSessionKey(EVAL_PK, verdictMessage(jobId, 'accept', DELIVERABLE_ROOT));
    await driveVerdict(jobId, { evaluatorSig: sig, fromAgentId: '' });
    expect((await getJob(db.pool, jobId))?.status).toBe('rejected');
    expect(await pendingApprovalCount(jobId)).toBe(0);
  });

  it('F-0c replay-after-approval: a forged replay cannot clobber an already-approved job', async () => {
    const jobId = await evaluatingJob();
    const good = await signWithSessionKey(EVAL_PK, verdictMessage(jobId, 'accept', DELIVERABLE_ROOT));
    await driveVerdict(jobId, { evaluatorSig: good });
    expect((await getJob(db.pool, jobId))?.status).toBe('awaiting_approval');

    // A stale/forged job.verdict arrives again for the SAME job. The idempotence
    // guard must short-circuit BEFORE any reject write — the approved job stands.
    const forged = await signWithSessionKey(ATTACKER_PK, verdictMessage(jobId, 'accept', DELIVERABLE_ROOT));
    await driveVerdict(jobId, { evaluatorSig: forged });
    expect((await getJob(db.pool, jobId))?.status).toBe('awaiting_approval');
    expect(await pendingApprovalCount(jobId)).toBe(1);
  });
});
