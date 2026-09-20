// LIVE: gateway → 0G Compute real completion (spec §7 "0G integration" row).
// The full production path: agent bearer token → interception → compute
// queue → router → trace record with x_0g_trace.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestDb, seedAgent, type TestDb } from '../test/helpers/db.js';
import { buildTestApp, type TestApp } from '../test/helpers/app.js';
import { ComputeQueue } from '../src/gateway/compute-queue.js';
import { generateGatewayToken, hashTokenSecret } from '../src/crypto/token.js';
import { listTraces } from '../src/trace/trace-store.js';
import { completionContent } from '../src/runtime/prompt.js';
import { COMPUTE_BASE_URL, LIVE_MODEL, requireEnv } from './helpers.js';

let db: TestDb;
let t: TestApp;

beforeAll(async () => {
  db = await createTestDb();
  t = buildTestApp(db.pool, {
    queue: new ComputeQueue({ baseUrl: COMPUTE_BASE_URL, apiKey: requireEnv('ZERO_G_COMPUTE_API_KEY') }),
  });
});

afterAll(async () => {
  await db.drop();
});

describe('gateway → 0G Compute (live)', () => {
  it('returns a real, non-empty completion and traces it with x_0g_trace', async () => {
    const gen = generateGatewayToken();
    const agentId = await seedAgent(db.pool, {
      tokenId: gen.tokenId,
      tokenHash: await hashTokenSecret(gen.secret),
    });

    const res = await request(t.app)
      .post('/v1/chat/completions')
      .set('authorization', `Bearer ${gen.token}`)
      .send({
        model: LIVE_MODEL,
        messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
        temperature: 0,
        max_tokens: 64,
      });

    expect(res.status).toBe(200);
    const content = completionContent(res.body);
    console.log(`0G Compute live completion (${LIVE_MODEL}): ${JSON.stringify(content)}`);
    expect(content.trim().length).toBeGreaterThan(0); // non-empty, no || fallback (Phase-0 gate)

    const traces = await listTraces(db.pool, agentId);
    const inference = traces.find((r) => r.kind === 'inference');
    expect(inference).toBeDefined();
    expect(inference?.response).toBeDefined();
    // x_0g_trace is the per-call audit hook (provider + request id + billing)
    console.log(`x_0g_trace: ${JSON.stringify(inference?.x0gTrace ?? null)}`);
    expect(inference?.x0gTrace?.provider).toBeTruthy();
    expect(inference?.x0gTrace?.request_id).toBeTruthy();
  });
});
