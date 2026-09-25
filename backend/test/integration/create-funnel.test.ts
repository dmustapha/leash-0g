import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import nock from 'nock';
import { createTestDb, type TestDb } from '../helpers/db.js';
import { buildTestApp, ownerAuth, UPSTREAM, type TestApp } from '../helpers/app.js';

let db: TestDb;
let t: TestApp;

const OWNER = '0x' + '7a'.repeat(20);
const OTHER = '0x' + '8b'.repeat(20);

const JOB_SPEC_BODY = {
  spec: { question: 'Will ETH exceed 4000 by year-end?', deliverableSchemaRef: 'prob-v1', acceptanceRef: 'floor-v1' },
  acceptance: { label: 'calibrated forecast', rules: [{ kind: 'required', path: 'probability' }] },
  feeAmountWei: '5000000',
};

function modelReply(content: unknown): void {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  nock(UPSTREAM).post('/v1/chat/completions').reply(200, { choices: [{ message: { content: text } }] });
}

async function count(table: 'agents' | 'job_specs'): Promise<number> {
  const res = await db.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
  return Number(res.rows[0]?.n ?? 0);
}

beforeAll(async () => {
  db = await createTestDb();
  nock.disableNetConnect();
  nock.enableNetConnect(/127\.0\.0\.1|localhost|neon\.tech/);
});

beforeEach(() => {
  t = buildTestApp(db.pool);
});

afterEach(() => nock.cleanAll());

afterAll(async () => {
  nock.enableNetConnect();
  await db.drop();
});

describe('GET /api/job-specs (D-A2)', () => {
  it('lists the owner saved specs with ref/label/questionPreview', async () => {
    const owner = '0x' + 'a1'.repeat(20);
    await request(t.app).put('/api/job-specs/eth-4000').set('authorization', ownerAuth(owner)).send(JOB_SPEC_BODY).expect(200);
    const res = await request(t.app).get('/api/job-specs').set('authorization', ownerAuth(owner));
    expect(res.status).toBe(200);
    expect(res.body.specs).toHaveLength(1);
    expect(res.body.specs[0]).toMatchObject({ ref: 'eth-4000', label: 'calibrated forecast' });
    expect(res.body.specs[0].questionPreview).toContain('ETH');
  });

  it('empty list for a new owner', async () => {
    const fresh = '0x' + 'ee'.repeat(20);
    const res = await request(t.app).get('/api/job-specs').set('authorization', ownerAuth(fresh));
    expect(res.status).toBe(200);
    expect(res.body.specs).toEqual([]);
  });

  it('is owner-scoped: A never sees B specs', async () => {
    await request(t.app).put('/api/job-specs/secret').set('authorization', ownerAuth(OWNER)).send(JOB_SPEC_BODY).expect(200);
    const res = await request(t.app).get('/api/job-specs').set('authorization', ownerAuth(OTHER));
    expect(res.body.specs).toEqual([]);
  });

  it('401 without auth', async () => {
    await request(t.app).get('/api/job-specs').expect(401);
  });
});

describe('POST /api/create/elevate (D-B1/B2/B4 — quarantine + never-guess-money)', () => {
  it('returns a strict-valid draft from model output', async () => {
    modelReply({
      proposedRole: 'provider',
      rationale: 'summarize research',
      capabilityLabel: 'research summarizer',
      serviceSpec: 'concise research summaries',
      confidence: 'high',
    });
    const res = await request(t.app)
      .post('/api/create/elevate')
      .set('authorization', ownerAuth(OWNER))
      .send({ intent: 'summarize research papers for me' });
    expect(res.status).toBe(200);
    expect(res.body.draft.proposedRole).toBe('provider');
    expect(res.body.draft.moneyPower).toBe('cannot-move-money');
  });

  it('WRITES NOTHING: no agent or job_spec row created by /elevate (quarantine)', async () => {
    const agentsBefore = await count('agents');
    const specsBefore = await count('job_specs');
    modelReply({ proposedRole: 'treasury', rationale: 'r', confidence: 'high', suggestedPolicy: { perTransferCapWei: '1000', windowCapWei: '5000', windowSeconds: 3600 } });
    await request(t.app).post('/api/create/elevate').set('authorization', ownerAuth(OWNER)).send({ intent: 'manage my allowance' }).expect(200);
    expect(await count('agents')).toBe(agentsBefore);
    expect(await count('job_specs')).toBe(specsBefore);
  });

  it('never returns an address even if the model hallucinates one', async () => {
    modelReply({
      proposedRole: 'requester',
      rationale: 'buy a forecast',
      feeRecipient: '0x' + 'de'.repeat(20),
      settlementToken: '0x' + 'ad'.repeat(20),
      confidence: 'high',
    });
    const res = await request(t.app).post('/api/create/elevate').set('authorization', ownerAuth(OWNER)).send({ intent: 'buy a forecast' }).expect(200);
    expect(JSON.stringify(res.body.draft)).not.toMatch(/0x[0-9a-f]{40}/i);
  });

  it('malformed model output ⇒ safe fallback, still 200', async () => {
    nock(UPSTREAM).post('/v1/chat/completions').reply(200, { choices: [{ message: { content: 'garbage {' } }] });
    // retry too:
    nock(UPSTREAM).post('/v1/chat/completions').reply(200, { choices: [{ message: { content: 'still garbage' } }] });
    const res = await request(t.app).post('/api/create/elevate').set('authorization', ownerAuth(OWNER)).send({ intent: 'watch my wallet' }).expect(200);
    expect(res.body.draft.confidence).toBe('low');
  });

  it('400 on empty intent; 401 without auth', async () => {
    await request(t.app).post('/api/create/elevate').set('authorization', ownerAuth(OWNER)).send({ intent: '' }).expect(400);
    await request(t.app).post('/api/create/elevate').send({ intent: 'x' }).expect(401);
  });
});
