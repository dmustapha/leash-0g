import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { buildTestApp, ownerAuth, type TestApp } from '../helpers/app.js';
import { createJob } from '../../src/store/jobs.js';

/**
 * Phase-4 ACP job read API (spec §7): the owner-seeded job-spec registry + the
 * job projection read model the cockpit consumes. Owner-scoped: a job is only
 * visible to its owner (cross-owner reads 404, never leak).
 */

const OWNER = '0x' + '5a'.repeat(20);
const OTHER = '0x' + '5b'.repeat(20);
const TOKEN = '0x' + '77'.repeat(20);
const RECIPIENT = '0x' + '9c'.repeat(20);

const SPEC = {
  question: 'Will ETH close above $4000 this month?',
  deliverableSchemaRef: 'market-probability@v1',
  acceptanceRef: 'market-floor',
};
const ACCEPTANCE = {
  label: 'market-floor',
  rules: [
    { kind: 'required' as const, path: 'probability' },
    { kind: 'numberRange' as const, path: 'probability', min: 0, max: 1 },
  ],
};

let db: TestDb;
let t: TestApp;

beforeAll(async () => {
  db = await createTestDb();
  t = buildTestApp(db.pool);
});

afterAll(async () => {
  await db.drop();
});

async function seedTriangleAndJob(ownerAddr: string): Promise<string> {
  const mk = (goal: Record<string, unknown>, name: string) =>
    seedAgent(db.pool, { ownerAddr, goal, name });
  const provider = await mk({ type: 'provider', serviceSpec: 's' }, 'p');
  const evaluator = await mk({ type: 'evaluator', rubricRef: 'r' }, 'e');
  const requester = await mk({ type: 'requester', jobSpecSource: 'j' }, 'req');
  const job = await createJob(db.pool, {
    jobId: crypto.randomUUID(),
    ownerAddr,
    requesterAgentId: requester,
    providerAgentId: provider,
    evaluatorAgentId: evaluator,
    spec: SPEC,
    jobSpecHash: '0x' + '11'.repeat(32),
    requesterSig: '0xsig',
    feeToken: TOKEN,
    feeAmountWei: '5000000',
    feeRecipient: RECIPIENT,
  });
  return job.jobId;
}

describe('Phase-4 job API', () => {
  it('seeds + reads back an owner job spec (F5 authority stays server-side)', async () => {
    const put = await request(t.app)
      .put('/api/job-specs/eth-4000')
      .set('authorization', ownerAuth(OWNER))
      .send({ spec: SPEC, acceptance: ACCEPTANCE, feeAmountWei: '5000000' });
    expect(put.status).toBe(200);
    expect(put.body.sourceRef).toBe('eth-4000');

    const get = await request(t.app).get('/api/job-specs/eth-4000').set('authorization', ownerAuth(OWNER));
    expect(get.status).toBe(200);
    expect(get.body.feeAmountWei).toBe('5000000');
    expect(get.body.spec.question).toBe(SPEC.question);
    expect(get.body.acceptance.rules).toHaveLength(2);
  });

  it('rejects a malformed job spec (the API is the enforcement boundary)', async () => {
    const bad = await request(t.app)
      .put('/api/job-specs/bad')
      .set('authorization', ownerAuth(OWNER))
      .send({ spec: { question: '' }, acceptance: ACCEPTANCE, feeAmountWei: 'notwei' });
    expect(bad.status).toBe(400);
  });

  it('lists + reads a job for its owner; the full lifecycle view is present', async () => {
    const jobId = await seedTriangleAndJob(OWNER);

    const list = await request(t.app).get('/api/jobs').set('authorization', ownerAuth(OWNER));
    expect(list.status).toBe(200);
    expect(list.body.jobs.some((j: { jobId: string }) => j.jobId === jobId)).toBe(true);

    const one = await request(t.app).get(`/api/jobs/${jobId}`).set('authorization', ownerAuth(OWNER));
    expect(one.status).toBe(200);
    expect(one.body.status).toBe('originated');
    expect(one.body.feeAmountWei).toBe('5000000');
    expect(one.body.spec.question).toBe(SPEC.question);
    expect(one.body.deliverable).toBeNull(); // not delivered yet
    expect(one.body.poa).toBeNull();
  });

  it('never leaks a job across owners (404, not another owner’s data)', async () => {
    const jobId = await seedTriangleAndJob(OWNER);
    const cross = await request(t.app).get(`/api/jobs/${jobId}`).set('authorization', ownerAuth(OTHER));
    expect(cross.status).toBe(404);

    const otherList = await request(t.app).get('/api/jobs').set('authorization', ownerAuth(OTHER));
    expect(otherList.body.jobs.some((j: { jobId: string }) => j.jobId === jobId)).toBe(false);
  });
});
