// File: web/tests/owner-stream-badge.test.tsx
// Shared owner-stream hook + nav unread badge: seeds from GET /api/alerts, updates live when
// an alert frame is pushed on the (mocked) SSE connection, and holds ONE shared connection
// across multiple subscribers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

// Mock the SSE transport: capture onEvent so tests can push owner-stream frames.
const pushRef: { push: ((data: unknown) => void) | null; connects: number } = {
  push: null,
  connects: 0,
};
vi.mock('@/lib/sse', () => ({
  connectSse: (opts: { onEvent: (data: unknown) => void }) => {
    pushRef.connects += 1;
    pushRef.push = opts.onEvent;
    return { close: () => undefined };
  },
}));

// Mock the wallet context: authenticated, STABLE identity (the real usePrivyWallet memoizes —
// an unstable wallet object would retrigger data effects on every render).
const WALLET = {
  ready: true,
  authenticated: true,
  address: '0x3333333333333333333333333333333333333333',
  login: () => undefined,
  logout: () => undefined,
  getToken: async () => 'test-token',
  signMessage: async () => '0xsig',
  getProvider: async () => {
    throw new Error('no provider in tests');
  },
};
vi.mock('@/lib/owner-wallet', () => ({
  useOwnerWallet: () => WALLET,
}));

import { resetOwnerStreamForTests, useOwnerStream } from '@/lib/use-owner-stream';
import { UnreadBadge } from '@/components/inbox/UnreadBadge';

function mockAlertsFetch(unreadSequence: number[]) {
  let call = 0;
  const fetchMock = vi.fn(async () => {
    const unread = unreadSequence[Math.min(call, unreadSequence.length - 1)] ?? 0;
    call += 1;
    return new Response(JSON.stringify({ alerts: [], unread }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function alertFrame(id: string, status = 'unread') {
  return {
    type: 'alert',
    alert: {
      id,
      ownerAddr: '0x3333333333333333333333333333333333333333',
      class: 'info',
      kind: 'revoked',
      status,
      summary: 'x',
      refs: {},
      count: 1,
      createdAt: new Date().toISOString(),
    },
  };
}

beforeEach(() => {
  pushRef.push = null;
  pushRef.connects = 0;
});

afterEach(() => {
  resetOwnerStreamForTests();
  vi.unstubAllGlobals();
});

describe('UnreadBadge + useOwnerStream', () => {
  it('seeds from the API, then updates when an alert frame is pushed', async () => {
    mockAlertsFetch([1, 2]);
    render(<UnreadBadge />);
    expect(await screen.findByTestId('nav-unread-badge')).toHaveTextContent('1');

    await act(async () => {
      pushRef.push?.(alertFrame('al-2'));
      // let the refetch promise settle
      await Promise.resolve();
    });
    expect(await screen.findByTestId('nav-unread-badge')).toHaveTextContent('2');
  });

  it('renders nothing at zero unread (quiet nav — not a chore queue)', async () => {
    mockAlertsFetch([0]);
    render(<UnreadBadge />);
    // give the seed fetch a tick
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId('nav-unread-badge')).not.toBeInTheDocument();
  });

  it('multiple subscribers share ONE SSE connection', async () => {
    mockAlertsFetch([0]);
    const events: unknown[] = [];
    function Probe() {
      useOwnerStream((ev) => events.push(ev));
      return null;
    }
    render(
      <>
        <Probe />
        <Probe />
        <UnreadBadge />
      </>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(pushRef.connects).toBe(1);
    await act(async () => {
      pushRef.push?.(alertFrame('al-9'));
      await Promise.resolve();
    });
    expect(events).toHaveLength(2);
  });
});
