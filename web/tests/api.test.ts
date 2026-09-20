// File: web/tests/api.test.ts
// API client error parsing: backend errors are shaped { error: { message } } (owner-routes)
// and must surface as readable strings — never "[object Object]". Also the getTraces
// contract: numeric cursor, nextCursor: number | null, chainVerified surfaced.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, makeApi } from '@/lib/api';

const getToken = async () => 'tok';

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    statusText: 'Bad Request',
    json: async () => body,
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api error shape', () => {
  it('parses the backend { error: { message } } shape into a readable message', async () => {
    stubFetch(400, { error: { message: 'invalid request body' } });
    const err = await makeApi(getToken)
      .start('agent-1')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe('invalid request body');
    expect((err as ApiError).message).not.toContain('[object Object]');
  });

  it('still accepts a plain-string error field', async () => {
    stubFetch(404, { error: 'no mock for GET /nope' });
    const err = await makeApi(getToken)
      .start('agent-1')
      .catch((e: unknown) => e);
    expect((err as ApiError).message).toBe('no mock for GET /nope');
  });

  it('falls back to top-level message, then statusText', async () => {
    stubFetch(500, { message: 'boom' });
    const a = await makeApi(getToken)
      .start('agent-1')
      .catch((e: unknown) => e);
    expect((a as ApiError).message).toBe('boom');

    stubFetch(500, {});
    const b = await makeApi(getToken)
      .start('agent-1')
      .catch((e: unknown) => e);
    expect((b as ApiError).message).toBe('Bad Request');
  });
});

describe('getTraces contract', () => {
  it('surfaces nextCursor (number | null) and chainVerified, and sends a numeric cursor', async () => {
    const fn = stubFetch(200, { records: [], nextCursor: null, chainVerified: true });
    const res = await makeApi(getToken).getTraces('agent-1', 41);
    // Compile-time: nextCursor is number | null, chainVerified is boolean.
    const cursor: number | null = res.nextCursor;
    const verified: boolean = res.chainVerified;
    expect(cursor).toBeNull();
    expect(verified).toBe(true);
    const url = (fn.mock.calls[0] as [string, unknown])[0];
    expect(url).toContain('/api/agents/agent-1/traces?cursor=41');
  });
});
