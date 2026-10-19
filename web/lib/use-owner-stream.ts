// File: web/lib/use-owner-stream.ts
// ONE shared owner-stream SSE connection for the whole app (spec §3c): SiteNav badge and the
// inbox both subscribe here, so the browser holds a single /api/owner/stream connection no
// matter how many surfaces listen. Module-level manager + refcounted close.
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { config } from './config';
import { connectSse, type SseHandle } from './sse';
import { makeApi } from './api';
import { useOwnerWallet } from './owner-wallet';
import type { OwnerStreamEvent } from './types';

type Listener = (ev: OwnerStreamEvent) => void;
/** Live transport state of the shared owner stream (mirrors lib/sse.ts). */
export type StreamStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';
type StatusListener = (s: StreamStatus) => void;

let handle: SseHandle | null = null;
let currentGetToken: (() => Promise<string | null>) | null = null;
const listeners = new Set<Listener>();
const statusListeners = new Set<StatusListener>();
let currentStatus: StreamStatus = 'closed';

function setStatus(s: StreamStatus): void {
  currentStatus = s;
  for (const l of statusListeners) l(s);
}

function ensureConnected(getToken: () => Promise<string | null>): void {
  currentGetToken = getToken;
  if (handle) return;
  handle = connectSse({
    url: `${config.apiUrl}/api/owner/stream`,
    getToken: () => (currentGetToken ? currentGetToken() : Promise.resolve(null)),
    // Fan the transport state out to the topbar LIVE indicator (and any other status subscriber).
    onStatusChange: setStatus,
    onEvent: (data) => {
      const ev = data as OwnerStreamEvent;
      if (ev && typeof ev === 'object' && 'type' in ev) {
        for (const l of listeners) l(ev);
      }
    },
  });
}

/** Test hook: drop the shared connection + listeners between tests. */
export function resetOwnerStreamForTests(): void {
  handle?.close();
  handle = null;
  currentGetToken = null;
  listeners.clear();
  statusListeners.clear();
  currentStatus = 'closed';
}

/**
 * Subscribe to the owner aggregate stream. The callback ref is kept fresh so callers can pass
 * inline closures without re-subscribing (and without tearing the shared connection down).
 */
export function useOwnerStream(onEvent: Listener): void {
  const wallet = useOwnerWallet();
  const cb = useRef(onEvent);
  cb.current = onEvent;

  useEffect(() => {
    if (!wallet.authenticated) return;
    const listener: Listener = (ev) => cb.current(ev);
    listeners.add(listener);
    ensureConnected(wallet.getToken);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        handle?.close();
        handle = null;
        setStatus('closed');
      }
    };
  }, [wallet.authenticated, wallet.getToken]);
}

/**
 * Live transport state of the shared owner stream, for the topbar LIVE indicator. Subscribing
 * here holds the shared connection open (a no-op event listener keeps the refcount), so the dot
 * reflects the REAL stream — `open` = live, `connecting`/`reconnecting` = the rail is settling,
 * `closed` = no stream. When the owner is not authenticated there is no stream, so it stays
 * `closed` and the topbar shows nothing (an unauthenticated "LIVE" would be a false claim).
 */
export function useOwnerStreamStatus(): StreamStatus {
  const wallet = useOwnerWallet();
  const [status, setLocal] = useState<StreamStatus>(currentStatus);

  useEffect(() => {
    if (!wallet.authenticated) {
      setLocal('closed');
      return;
    }
    const noop: Listener = () => {};
    const onStatus: StatusListener = (s) => setLocal(s);
    listeners.add(noop); // hold the refcount so the connection stays up for the indicator
    statusListeners.add(onStatus);
    ensureConnected(wallet.getToken);
    // Sync-read: reconcile to the manager's status NOW, in case the connection was already open
    // (another subscriber) or onStatusChange fired synchronously during ensureConnected.
    setLocal(currentStatus);
    return () => {
      statusListeners.delete(onStatus);
      listeners.delete(noop);
      if (listeners.size === 0) {
        handle?.close();
        handle = null;
        setStatus('closed');
      }
    };
  }, [wallet.authenticated, wallet.getToken]);

  return status;
}

/**
 * Live unread-alert count for the SiteNav badge: seeded from GET /api/alerts, refreshed from
 * the server whenever an alert frame arrives (the server is the source of truth — coalescing
 * and resolution never drift a client-side counter).
 */
export function useUnreadAlerts(): number {
  const wallet = useOwnerWallet();
  const api = useMemo(() => makeApi(wallet.getToken), [wallet.getToken]);
  const [unread, setUnread] = useState(0);

  const refresh = useCallback(async () => {
    try {
      setUnread((await api.listAlerts({ limit: 1 })).unread);
    } catch {
      /* badge simply keeps its last value */
    }
  }, [api]);

  useEffect(() => {
    if (wallet.authenticated) void refresh();
  }, [wallet.authenticated, refresh]);

  useOwnerStream((ev) => {
    if (ev.type === 'alert') void refresh();
  });

  return unread;
}
