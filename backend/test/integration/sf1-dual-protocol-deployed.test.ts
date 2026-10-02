import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { buildTestApp, type TestApp } from '../helpers/app.js';
import { ComputeQueue } from '../../src/gateway/compute-queue.js';
import { generateGatewayToken, hashTokenSecret } from '../../src/crypto/token.js';
import { listTraces } from '../../src/trace/trace-store.js';
import request from 'supertest';

/**
 * SF-1 F-1d [DEPLOY] — a bound agent reasons through BOTH an OpenAI-shaped and
 * an Anthropic-shaped call on the LIVE stack (real 0G Compute), both traced, on
 * 0G Compute. The two protocols hit the SAME 0G-Compute OpenAI backend (SD-F4):
 * the Anthropic path is adapted in, governed by the same pipeline, and adapted
 * back out — proving "cockpit for ANY agent" (00:91) end-to-end.
 *
 * SE-4 conventions: gated behind RUN_DEPLOYED_DRILL=1 (needs live 0G + a funded
 * compute key); idempotent (hermetic per-run Neon, auto-dropped); RPC/compute
 * flake-tolerant (a transient non-200 is retried a bounded number of times,
 * never recorded as a logic failure — the ComputeQueue also retries 429/5xx).
 */

const RUN = process.env.RUN_DEPLOYED_DRILL === '1';

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    for (const line of readFileSync(new URL('../../.env', import.meta.url), 'utf8').split('\n')) {
      const t = line.trim();
      if (t && !t.startsWith('#') && t.includes('=')) {
        const i = t.indexOf('=');
        env[t.slice(0, i)] = t.slice(i + 1).replace(/^"|"$/g, '');
      }
    }
  } catch {
    /* .env optional when vars come from the environment */
  }
  return { ...env, ...process.env } as Record<string, string>;
}

let db: TestDb;
let t: TestApp;

beforeAll(async () => {
  if (!RUN) return;
  const env = loadEnv();
  const apiKey = env.ZERO_G_COMPUTE_API_KEY;
  if (!apiKey) throw new Error('missing ZERO_G_COMPUTE_API_KEY for the SF-1 [DEPLOY] drill');
  const baseUrl = env.COMPUTE_BASE_URL ?? 'https://router-api.0g.ai/v1';
  db = await createTestDb();
  const queue = new ComputeQueue({ baseUrl, apiKey, maxRetries: 4, baseDelayMs: 800, timeoutMs: 90_000 });
  t = buildTestApp(db.pool, { queue });
}, 120_000);

afterAll(async () => {
  if (RUN && db) await db.drop();
});

async function seedToken(): Promise<string> {
  const gen = generateGatewayToken();
  await seedAgent(db.pool, { tokenId: gen.tokenId, tokenHash: await hashTokenSecret(gen.secret) });
  return gen.token;
}

/** Bounded flake tolerance: retry a transient non-2xx a few times (compute degraded != logic fail). */
async function withRetry(fn: () => Promise<request.Response>, tries = 4): Promise<request.Response> {
  let last!: request.Response;
  for (let i = 0; i < tries; i++) {
    last = await fn();
    if (last.status === 200) return last;
    await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
  }
  return last;
}

(RUN ? describe : describe.skip)('SF-1 F-1d — dual-protocol reason on the LIVE 0G stack', () => {
  it('an OpenAI-shaped call reasons on 0G Compute and is traced with an x_0g_trace', async () => {
    const token = await seedToken();
    const res = await withRetry(() =>
      request(t.gatewayApp)
        .post('/v1/chat/completions')
        .set('authorization', `Bearer ${token}`)
        .send({ model: 'deepseek-v3', messages: [{ role: 'user', content: 'Reply with the single word: pong.' }], max_tokens: 16 }),
    );
    expect(res.status).toBe(200);
    expect(res.body.choices?.[0]?.message?.content).toBeTypeOf('string');
    const inf = (await listTraces(db.pool, await agentIdFor(token))).find((r) => r.kind === 'inference');
    expect(inf?.x0gTrace?.request_id).toBeTruthy();
    expect(inf?.detail).toBeUndefined(); // OpenAI path carries no protocol tag
  }, 120_000);

  it('an Anthropic-shaped call reasons on the SAME backend, returns Anthropic shape, is traced with protocol=anthropic', async () => {
    const token = await seedToken();
    const res = await withRetry(() =>
      request(t.gatewayApp)
        .post('/v1/messages')
        .set('authorization', `Bearer ${token}`)
        .send({ model: 'deepseek-v3', max_tokens: 16, messages: [{ role: 'user', content: 'Reply with the single word: pong.' }] }),
    );
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('message');
    expect(res.body.role).toBe('assistant');
    expect(Array.isArray(res.body.content)).toBe(true);
    const inf = (await listTraces(db.pool, await agentIdFor(token))).find((r) => r.kind === 'inference');
    expect(inf?.x0gTrace?.request_id).toBeTruthy();
    expect(inf?.detail).toMatchObject({ protocol: 'anthropic' });
  }, 120_000);
});

async function agentIdFor(token: string): Promise<string> {
  const tokenId = /^leash_([0-9a-f]{16})_/.exec(token)?.[1];
  const r = await db.pool.query<{ id: string }>(`SELECT id FROM agents WHERE token_id = $1`, [tokenId]);
  return r.rows[0]!.id;
}
