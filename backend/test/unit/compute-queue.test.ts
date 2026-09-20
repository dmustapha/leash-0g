import { describe, it, expect, vi } from 'vitest';
import { ComputeQueue } from '../../src/gateway/compute-queue.js';

type FetchFn = typeof fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function makeQueue(fetchFn: FetchFn, opts: Partial<ConstructorParameters<typeof ComputeQueue>[0]> = {}) {
  return new ComputeQueue({
    baseUrl: 'https://compute.test/v1',
    apiKey: 'k',
    fetchFn,
    baseDelayMs: 5,
    maxRetries: 3,
    timeoutMs: 5_000,
    ...opts,
  });
}

describe('ComputeQueue', () => {
  it('forwards a request and captures x_0g_trace', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(200, {
        choices: [{ message: { content: 'hi' } }],
        x_0g_trace: { provider: '0xabc', request_id: 'r1', billing: { total: 1 } },
      }),
    );
    const q = makeQueue(fetchFn);
    const res = await q.enqueue('a1', { model: 'm', messages: [] });
    expect(res.status).toBe(200);
    expect(res.x0gTrace).toEqual({ provider: '0xabc', request_id: 'r1', billing: { total: 1 } });
    const call = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('https://compute.test/v1/chat/completions');
    expect((call[1].headers as Record<string, string>)['authorization']).toBe('Bearer k');
  });

  it('retries with backoff on 429 then succeeds', async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) return jsonResponse(429, { error: 'rate limited' });
      return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] });
    });
    const q = makeQueue(fetchFn);
    const res = await q.enqueue('a1', { model: 'm', messages: [] });
    expect(res.status).toBe(200);
    expect(calls).toBe(3);
  });

  it('gives up after maxRetries on persistent 5xx and reports the failure', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(503, { error: 'down' }));
    const q = makeQueue(fetchFn);
    const res = await q.enqueue('a1', { model: 'm', messages: [] });
    expect(res.status).toBe(503);
    expect(fetchFn).toHaveBeenCalledTimes(4); // initial + 3 retries
  });

  it('does NOT retry non-429 4xx', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(400, { error: 'bad request' }));
    const q = makeQueue(fetchFn);
    const res = await q.enqueue('a1', { model: 'm', messages: [] });
    expect(res.status).toBe(400);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('serializes requests per agent', async () => {
    const order: string[] = [];
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { tag: string };
      order.push(`start:${body.tag}`);
      await new Promise((r) => setTimeout(r, body.tag === 'first' ? 40 : 5));
      order.push(`end:${body.tag}`);
      return jsonResponse(200, { ok: true });
    });
    const q = makeQueue(fetchFn);
    await Promise.all([q.enqueue('a1', { tag: 'first' }), q.enqueue('a1', { tag: 'second' })]);
    expect(order).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
  });

  it('caps global concurrency at 5', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchFn = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
      return jsonResponse(200, { ok: true });
    });
    const q = makeQueue(fetchFn);
    await Promise.all(Array.from({ length: 12 }, (_, i) => q.enqueue(`agent-${i}`, {})));
    expect(peak).toBeLessThanOrEqual(5);
    expect(fetchFn).toHaveBeenCalledTimes(12);
  });

  it('retries on network errors', async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return jsonResponse(200, { ok: true });
    });
    const q = makeQueue(fetchFn);
    const res = await q.enqueue('a1', {});
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });
});
