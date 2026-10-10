import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDb, type TestDb } from '../helpers/db.js';
import { insertAgent } from '../../src/store/agents.js';
import { createJob, recordDelivery, markEvaluating, recordVerdict, getJob } from '../../src/store/jobs.js';
import type { AgentGoal } from '../../src/types.js';

// DM-8 (adversarial, round-3 critic): a delivery transition must advance ONLY
// from 'originated'. recordDelivery is CAS-guarded so a duplicated /
// checkpoint-replayed / out-of-order job.deliver cannot reset a job that already
// advanced past delivery (evaluating/verdict/awaiting_approval/...) back to
// delivered, which would re-open an approval card past verdict and clobber
// finality. (The requesterDeliver app-hoist short-circuits the replay earlier;
// this pins the DB-layer backstop — the un-driftable guarantee.)

let db: TestDb;
let requesterId: string;
let providerId: string;
let evaluatorId: string;

const OWNER = '0x' + '7d'.repeat(20);

async function makeAgent(name: string, goal: AgentGoal): Promise<string> {
  return insertAgent(db.pool, {
    chainAgentId: BigInt(Math.floor(Math.random() * 1e9)),
    chainId: 16602,
    ownerAddr: OWNER,
    accountAddr: '0x' + Math.floor(Math.random() * 1e9).toString(16).padStart(40, '0'),
    sessionKeyAddr: '0x' + Math.floor(Math.random() * 1e9).toString(16).padStart(40, '0'),
    sessionKeyEnc: 'enc',
    auditPubkey: 'ab'.repeat(33),
    tokenId: `tok-${name}-${Math.random()}`,
    tokenHash: 'hash',
    accountVersion: 4,
    name,
    gatewayRules: [],
    goal,
    guardianAddr: '0x' + 'ab'.repeat(20),
  });
}

beforeAll(async () => {
  db = await createTestDb();
  providerId = await makeAgent('prov', { type: 'provider', serviceSpec: 's' });
  evaluatorId = await makeAgent('eval', { type: 'evaluator', rubricRef: 'r' });
  requesterId = await makeAgent('req', {
    type: 'requester',
    jobSpecSource: 'js',
    providerAgentId: providerId,
    evaluatorAgentId: evaluatorId,
    feeToken: '0x' + 'ad'.repeat(20),
    feeRecipient: '0x' + 'be'.repeat(20),
    feeCapPerJobWei: '5000000',
  });
});

afterAll(async () => {
  await db.drop();
});

async function seedJob(jobId: string): Promise<void> {
  await createJob(db.pool, {
    jobId,
    ownerAddr: OWNER,
    requesterAgentId: requesterId,
    providerAgentId: providerId,
    evaluatorAgentId: evaluatorId,
    spec: { question: 'q', deliverableSchemaRef: 'd', acceptanceRef: 'a' },
    jobSpecHash: '0x' + '11'.repeat(32),
    requesterSig: 'sig',
    feeToken: '0x' + 'ad'.repeat(20),
    feeAmountWei: '2000000',
    feeRecipient: '0x' + 'be'.repeat(20),
  });
}

const delivery = {
  deliverable: { probability: 0.6 },
  deliverableRoot: '0x' + '22'.repeat(32),
  deliverableSummary: 'summary',
  providerSig: 'psig',
  acceptance: { passed: true, failures: [], checked: 1 },
  status: 'delivered' as const,
};

describe('DM-8 recordDelivery is CAS-guarded to originated', () => {
  it('advances originated -> delivered', async () => {
    const jobId = randomUUID();
    await seedJob(jobId);
    await recordDelivery(db.pool, jobId, delivery);
    expect((await getJob(db.pool, jobId))?.status).toBe('delivered');
  });

  it('does NOT re-deliver a job already past delivery (verdict) — the DM-8 bug', async () => {
    const jobId = randomUUID();
    await seedJob(jobId);
    await recordDelivery(db.pool, jobId, delivery);
    await markEvaluating(db.pool, jobId);
    await recordVerdict(db.pool, jobId, { verdict: 'accept', rationaleRef: 'r', evaluatorSig: 's' });
    expect((await getJob(db.pool, jobId))?.status).toBe('verdict');

    // Adversarial: a replayed job.deliver must be an idempotent no-op.
    await recordDelivery(db.pool, jobId, { ...delivery, deliverableSummary: 'REPLAYED' });
    const job = await getJob(db.pool, jobId);
    expect(job?.status).toBe('verdict'); // NOT reset to delivered
    expect(job?.verdict).toBe('accept'); // verdict finality preserved
  });

  it('does NOT re-deliver from evaluating', async () => {
    const jobId = randomUUID();
    await seedJob(jobId);
    await recordDelivery(db.pool, jobId, delivery);
    await markEvaluating(db.pool, jobId);

    await recordDelivery(db.pool, jobId, delivery);
    expect((await getJob(db.pool, jobId))?.status).toBe('evaluating'); // unchanged
  });
});
