import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Response } from 'express';
import { SseHub } from '../../src/sse/hub.js';

// P4C-1: SSE connections are bounded (global + per-owner) and idle/zombie
// sockets are reaped by a heartbeat write, so one authed owner cannot exhaust
// the single instance's FDs/heap (recurring MEDIUM since Phase 1).

interface FakeRes {
  res: Response;
  closeHandlers: Array<() => void>;
  errorHandlers: Array<() => void>;
  frames: string[];
  status: number | null;
  jsonBody: unknown;
  writeThrows: boolean;
  ended: boolean;
}

function makeRes(): FakeRes {
  const state: FakeRes = {
    closeHandlers: [],
    errorHandlers: [],
    frames: [],
    status: null,
    jsonBody: undefined,
    writeThrows: false,
    ended: false,
    res: null as unknown as Response,
  };
  const res = {
    writeHead: () => res,
    write: (chunk: string) => {
      if (state.writeThrows) throw new Error('EPIPE');
      state.frames.push(chunk);
      return true;
    },
    status: (code: number) => {
      state.status = code;
      return res;
    },
    json: (body: unknown) => {
      state.jsonBody = body;
      return res;
    },
    end: () => {
      state.ended = true;
      return res;
    },
    on: (event: string, handler: () => void) => {
      if (event === 'close') state.closeHandlers.push(handler);
      if (event === 'error') state.errorHandlers.push(handler);
      return res;
    },
  } as unknown as Response;
  state.res = res;
  return state;
}

describe('SseHub connection caps (P4C-1)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('accepts connections up to the per-owner cap, then rejects with 429', () => {
    const hub = new SseHub({ maxGlobal: 100, maxPerOwner: 2, idleTimeoutMs: 1000 });
    const a = makeRes();
    const b = makeRes();
    const c = makeRes();
    expect(hub.attach('agent1', a.res, '0xOWNER')).toBe(true);
    expect(hub.attach('agent2', b.res, '0xowner')).toBe(true); // case-insensitive owner
    expect(hub.attach('agent3', c.res, '0xOwner')).toBe(false);
    expect(c.status).toBe(429);
    expect(c.jsonBody).toMatchObject({ error: 'sse_capacity', scope: 'owner' });
    expect(hub.ownerConnections('0xowner')).toBe(2);
  });

  it('enforces the global cap across owners', () => {
    const hub = new SseHub({ maxGlobal: 1, maxPerOwner: 100, idleTimeoutMs: 1000 });
    const a = makeRes();
    const b = makeRes();
    expect(hub.attach('a1', a.res, '0xalice')).toBe(true);
    expect(hub.attach('a2', b.res, '0xbob')).toBe(false);
    expect(b.status).toBe(429);
    expect(b.jsonBody).toMatchObject({ scope: 'global' });
  });

  it('frees a slot on close so a new connection is admitted', () => {
    const hub = new SseHub({ maxGlobal: 100, maxPerOwner: 1, idleTimeoutMs: 1000 });
    const a = makeRes();
    expect(hub.attach('a1', a.res, '0xalice')).toBe(true);
    expect(hub.ownerConnections('0xalice')).toBe(1);
    a.closeHandlers.forEach((h) => h());
    expect(hub.ownerConnections('0xalice')).toBe(0);
    expect(hub.totalConnections()).toBe(0);
    const b = makeRes();
    expect(hub.attach('a2', b.res, '0xalice')).toBe(true);
  });

  it('reaps a zombie socket whose heartbeat write fails', () => {
    const hub = new SseHub({ maxGlobal: 100, maxPerOwner: 100, idleTimeoutMs: 1000 });
    const a = makeRes();
    hub.attach('a1', a.res, '0xalice');
    expect(hub.totalConnections()).toBe(1);
    a.writeThrows = true;
    vi.advanceTimersByTime(1000); // heartbeat fires, write throws → reaped
    expect(hub.totalConnections()).toBe(0);
    expect(hub.ownerConnections('0xalice')).toBe(0);
    expect(a.ended).toBe(true);
  });

  it('close is idempotent (close + error both fire)', () => {
    const hub = new SseHub({ maxGlobal: 100, maxPerOwner: 100, idleTimeoutMs: 1000 });
    const a = makeRes();
    hub.attach('a1', a.res, '0xalice');
    a.closeHandlers.forEach((h) => h());
    a.errorHandlers.forEach((h) => h());
    expect(hub.totalConnections()).toBe(0);
  });

  it('owner-stream attach counts toward the same owner cap', () => {
    const hub = new SseHub({ maxGlobal: 100, maxPerOwner: 1, idleTimeoutMs: 1000 });
    const a = makeRes();
    const b = makeRes();
    expect(hub.attachOwner('0xalice', a.res)).toBe(true);
    expect(hub.attach('a1', b.res, '0xalice')).toBe(false);
    expect(b.status).toBe(429);
  });

  it('unbounded by default (no limits passed) — existing behavior preserved', () => {
    const hub = new SseHub();
    for (let i = 0; i < 50; i++) {
      const r = makeRes();
      expect(hub.attach(`agent${i}`, r.res, '0xwhale')).toBe(true);
    }
    expect(hub.totalConnections()).toBe(50);
  });
});
