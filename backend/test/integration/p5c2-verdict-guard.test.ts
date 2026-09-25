import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDb, type TestDb } from '../helpers/db.js';
import { insertAgent } from '../../src/store/agents.js';
import { createJob, markEvaluating, recordVerdict, markAwaitingApproval, getJob } from '../../src/store/jobs.js';
import type { AgentGoal } from '../../src/types.js';

// P5C-2 (adversarial, per spec §10 / scope-review note #3): a duplicated or
// re-emitted job.verdict must be idempotent — recordVerdict advances ONLY from an
// evaluatable state, so a stray verdict can never re-drive a job that already
// reached verdict/approval, and thus can never spawn a second approval card.

let db: TestDb;
let requesterId: string;
let providerId: string;
let evaluatorId: string;

const OWNER = '0x' + '3c'.repeat(20);
const JOB_ORIG = randomUUID();
const JOB_DUP = randomUUID();
const JOB_AWAIT = randomUUID();

async function makeAgent(name: string, goal: AgentGoal): Promise<string> {
  return insertAgent(db.pool, {
    chainAgentId: BigInt(Math.floor(Math.random() * 1e9)),
    ownerAddr: OWNER,
    accountAddr: '0x' + Math.floor(Math.random() * 1e9).toString(16).padStart(40, '0'),
    sessionKeyAddr: '0x' + Math.floor(Math.random() * 1e9).toString(16).padStart(40, '0'),
    sessionKeyEnc: 'enc',
    auditPubkey: 'ab'.repeat(33),
    tokenId: `tok-${name}-${Math.random()}`,
    tokenHash: 'hash',
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

async function seedJob(jobId: string) {
  return createJob(db.pool, {
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

describe('P5C-2 recordVerdict idempotence', () => {
  it('does NOT advance from a non-evaluatable state (originated)', async () => {
    await seedJob(JOB_ORIG);
    const advanced = await recordVerdict(db.pool, JOB_ORIG, { verdict: 'accept', rationaleRef: 'r', evaluatorSig: 's' });
    expect(advanced).toBe(false);
    expect((await getJob(db.pool, JOB_ORIG))?.status).toBe('originated');
  });

  it('advances once from evaluating, then a duplicate verdict no-ops', async () => {
    await seedJob(JOB_DUP);
    await markEvaluating(db.pool, JOB_DUP);

    const first = await recordVerdict(db.pool, JOB_DUP, { verdict: 'accept', rationaleRef: 'r1', evaluatorSig: 's1' });
    expect(first).toBe(true);
    expect((await getJob(db.pool, JOB_DUP))?.status).toBe('verdict');

    // Adversarial: a re-emitted job.verdict (e.g. evaluator retry) must not re-drive.
    const dup = await recordVerdict(db.pool, JOB_DUP, { verdict: 'reject', rationaleRef: 'r2', evaluatorSig: 's2' });
    expect(dup).toBe(false);
    const job = await getJob(db.pool, JOB_DUP);
    expect(job?.status).toBe('verdict');
    expect(job?.verdict).toBe('accept'); // the first verdict stands; the duplicate did not overwrite
  });

  it('does not advance once an approval already exists (awaiting_approval)', async () => {
    await seedJob(JOB_AWAIT);
    await markEvaluating(db.pool, JOB_AWAIT);
    await recordVerdict(db.pool, JOB_AWAIT, { verdict: 'accept', rationaleRef: 'r', evaluatorSig: 's' });
    await markAwaitingApproval(db.pool, JOB_AWAIT, randomUUID());

    const dup = await recordVerdict(db.pool, JOB_AWAIT, { verdict: 'accept', rationaleRef: 'r', evaluatorSig: 's' });
    expect(dup).toBe(false);
    expect((await getJob(db.pool, JOB_AWAIT))?.status).toBe('awaiting_approval');
  });
});
