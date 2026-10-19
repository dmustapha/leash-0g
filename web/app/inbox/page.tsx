// File: web/app/inbox/page.tsx
// Alert inbox page: wires InboxView to GET /api/alerts + the shared owner stream. Decision
// cards decide through the SAME POST /api/approvals/:id rails as the cockpit; the stream
// pushes the resolved alert back and the card updates in place (with a refetch as belt-and-
// braces — the server is the source of truth).
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { makeApi } from '@/lib/api';
import { useOwnerWallet } from '@/lib/owner-wallet';
import { useOwnerStream } from '@/lib/use-owner-stream';
import type { Alert } from '@/lib/types';
import { InboxView } from '@/components/inbox/InboxView';

export default function InboxPage() {
  const wallet = useOwnerWallet();
  const api = useMemo(() => makeApi(wallet.getToken), [wallet.getToken]);

  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [unread, setUnread] = useState(0);
  const [agents, setAgents] = useState<Array<{ agentId: string; name: string }>>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await api.listAlerts();
      setAlerts(res.alerts);
      setUnread(res.unread);
      setLoadError(null);
      setLoaded(true); // only a SUCCESSFUL load counts — a failed first GET must show the error state
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load your inbox.');
    }
  }, [api]);

  useEffect(() => {
    if (!wallet.authenticated) return;
    void refresh();
    api
      .listAgents()
      .then((r) => setAgents(r.agents.map((a) => ({ agentId: a.agentId, name: a.name }))))
      .catch(() => {
        /* the agent filter simply stays empty */
      });
  }, [wallet.authenticated, refresh, api]);

  // Live updates: new alerts prepend, updated ones (resolved/coalesced) replace in place.
  useOwnerStream((ev) => {
    if (ev.type !== 'alert') return;
    setAlerts((prev) => {
      const idx = prev.findIndex((a) => a.id === ev.alert.id);
      if (idx === -1) return [ev.alert, ...prev];
      const next = [...prev];
      next[idx] = ev.alert;
      return next;
    });
    // Badge truth comes from the server on every alert frame (same pattern as
    // useUnreadAlerts) — a hand-maintained counter drifts under coalescing
    // and cross-channel resolution.
    void api
      .listAlerts({ limit: 1 })
      .then((r) => setUnread(r.unread))
      .catch(() => {
        /* badge keeps its last value */
      });
  });

  const onDecide = useCallback(
    async (approvalId: string, decision: 'approve' | 'deny') => {
      await api.decideApproval(approvalId, { decision });
      await refresh();
    },
    [api, refresh],
  );

  const onDismiss = useCallback(
    async (alertId: string) => {
      await api.alertAction(alertId, 'dismiss');
      await refresh();
    },
    [api, refresh],
  );

  const onMarkAllRead = useCallback(async () => {
    await api.markAllAlertsRead();
    await refresh();
  }, [api, refresh]);

  // The page title ("Inbox") lives in the shell topbar now, so the view renders straight
  // into the content area — no page-level hero.
  if (!wallet.ready) {
    return (
      <p role="status" style={{ color: 'var(--ink-dim)' }}>
        Loading…
      </p>
    );
  }
  if (!wallet.authenticated) {
    return (
      <div className="deadstate">
        <svg className="leash-svg" viewBox="0 0 80 44" aria-hidden="true">
          <circle className="leash-clasp" cx="10" cy="22" r="6" />
          <path className="leash-path" d="M16 22 Q 40 30 74 22" />
        </svg>
        <h4>Connect your wallet</h4>
        <p>Sign in to see the attention queue — approvals waiting on you and what your agents flagged.</p>
        <button type="button" className="btn btn-primary" onClick={wallet.login}>
          Connect wallet
        </button>
      </div>
    );
  }

  if (loadError && !loaded) {
    return (
      <div className="deadstate error" role="alert">
        <h4>Could not load your inbox</h4>
        <p>{loadError}</p>
        <button type="button" className="btn btn-ghost" onClick={() => void refresh()}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <InboxView
      alerts={alerts}
      unread={unread}
      agents={agents}
      onDecide={onDecide}
      onDismiss={onDismiss}
      onMarkAllRead={onMarkAllRead}
    />
  );
}
