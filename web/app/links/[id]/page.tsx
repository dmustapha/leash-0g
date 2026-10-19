// File: web/app/links/[id]/page.tsx
// Pair view (spec §3c, S8): BOTH agents' live streams side-by-side — two per-agent SSE
// connections reusing the existing /stream client — plus the shared handoff timeline
// (GET /api/delegations?linkId merged with live `delegation` SSE events) and REVOKE PAIR.
'use client';

import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { Address } from 'viem';
import { makeApi } from '@/lib/api';
import { useOwnerWallet } from '@/lib/owner-wallet';
import { connectSse, type SseHandle } from '@/lib/sse';
import { revokeOnchain } from '@/lib/chain';
import { applyDelegationEvent } from '@/lib/delegations';
import type { AgentSummary, Delegation, Link as AgentLink, StreamEvent } from '@/lib/types';
import { StreamFeed, type FeedItem } from '@/components/cockpit/StreamFeed';
import { DelegationTimeline } from '@/components/links/DelegationTimeline';
import { RevokePairButton } from '@/components/links/RevokePairButton';

type Connection = 'connecting' | 'open' | 'reconnecting' | 'closed';

export default function PairViewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: linkId } = use(params);
  const wallet = useOwnerWallet();
  const api = useMemo(() => makeApi(wallet.getToken), [wallet.getToken]);

  const [link, setLink] = useState<AgentLink | null>(null);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [delegations, setDelegations] = useState<Delegation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [feeds, setFeeds] = useState<Record<string, FeedItem[]>>({});
  const [connections, setConnections] = useState<Record<string, Connection>>({});
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [linksRes, agentsRes, delRes] = await Promise.all([
        api.listLinks(),
        api.listAgents(),
        api.listDelegations({ linkId }),
      ]);
      const found = linksRes.links.find((l) => l.id === linkId);
      if (!found) {
        setError('This link does not exist (or is not yours).');
        return;
      }
      setLink(found);
      setAgents(agentsRes.agents);
      setDelegations(delRes.delegations);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this pair.');
    }
  }, [api, linkId]);

  useEffect(() => {
    if (wallet.authenticated) void load();
  }, [wallet.authenticated, load]);

  const agentNames = useMemo(
    () => Object.fromEntries(agents.map((a) => [a.agentId, a.name])),
    [agents],
  );
  const pairIds = useMemo(
    () => (link ? [link.fromAgentId, link.toAgentId] : []),
    [link],
  );

  // S8: one SSE connection per agent, both reusing the existing /stream client.
  // `delegation` events from EITHER stream merge into the shared timeline (idempotent).
  useEffect(() => {
    if (!wallet.authenticated || pairIds.length !== 2) return;
    const handles: SseHandle[] = pairIds.map((agentId) =>
      connectSse({
        url: api.streamUrl(agentId),
        getToken: wallet.getToken,
        onStatusChange: (s) => setConnections((prev) => ({ ...prev, [agentId]: s })),
        onEvent: (data) => {
          const ev = data as StreamEvent;
          const nid = `ev-${seqRef.current++}`;
          if (ev.type === 'reasoning') {
            setFeeds((prev) => ({
              ...prev,
              [agentId]: [...(prev[agentId] ?? []).slice(-199), { kind: 'reasoning', text: ev.text, id: nid, ...(ev.meta ? { meta: ev.meta } : {}) }],
            }));
          } else if (ev.type === 'trace') {
            setFeeds((prev) => ({
              ...prev,
              [agentId]: [...(prev[agentId] ?? []).slice(-199), { kind: 'trace', event: ev, id: nid }],
            }));
          } else if (ev.type === 'delegation') {
            setDelegations((prev) => applyDelegationEvent(prev, ev));
          }
        },
      }),
    );
    return () => handles.forEach((h) => h.close());
  }, [api, pairIds, wallet.authenticated, wallet.getToken]);

  const revokeBatch = useCallback(async () => {
    const res = await api.revokeBatch(pairIds);
    await load();
    return res.results;
  }, [api, pairIds, load]);

  const walletRevoke = useCallback(
    async (accountAddr: Address) => {
      if (!wallet.address) throw new Error('Connect your wallet first.');
      const provider = await wallet.getProvider();
      return revokeOnchain(provider, wallet.address, accountAddr);
    },
    [wallet],
  );

  if (!wallet.ready) {
    return <Shell><p role="status" style={{ color: 'var(--ink-dim)' }}>Loading…</p></Shell>;
  }
  if (!wallet.authenticated) {
    return (
      <Shell>
        <div className="deadstate">
          <svg className="leash-svg" viewBox="0 0 80 44" aria-hidden="true">
            <circle className="leash-clasp" cx="10" cy="22" r="6" />
            <path className="leash-path" d="M16 22 Q 40 30 74 22" />
          </svg>
          <h4>Connect your wallet</h4>
          <p>Sign in to watch this pair — both agents&apos; live streams and their shared handoff history.</p>
          <button type="button" className="btn btn-primary" onClick={wallet.login}>
            Connect wallet
          </button>
        </div>
      </Shell>
    );
  }
  if (error && !link) {
    return (
      <Shell>
        <div className="deadstate error" role="alert">
          <h4>Could not load this pair</h4>
          <p>{error}</p>
          <button type="button" className="btn btn-ghost" onClick={() => void load()}>
            Retry
          </button>
        </div>
      </Shell>
    );
  }
  if (!link) {
    return <Shell><p role="status" style={{ color: 'var(--ink-dim)' }}>Loading this pair…</p></Shell>;
  }

  const name = (id: string) => agentNames[id] ?? `${id.slice(0, 8)}…`;

  return (
    <Shell
      title={`${name(link.fromAgentId)} → ${name(link.toAgentId)}`}
      aside={
        <span style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center' }}>
          <span className={`mode-chip ${link.mode}`}>{link.mode}</span>
          <span className={`spill ${link.status === 'active' ? 'running' : link.status === 'paused' ? 'paused' : 'revoked'}`}>
            {link.status}
          </span>
        </span>
      }
    >
      <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', alignItems: 'start' }}>
        {pairIds.map((agentId) => (
          <section key={agentId} aria-label={`${name(agentId)} live stream`} style={{ display: 'grid', gap: '0.5rem' }}>
            <h2 style={{ fontSize: '1rem' }}>
              <Link href={`/agents/${agentId}`} className="link-tx" style={{ fontFamily: 'var(--font-sans)', fontSize: '1rem' }}>
                {name(agentId)}
              </Link>
            </h2>
            <StreamFeed items={feeds[agentId] ?? []} connection={connections[agentId] ?? 'connecting'} />
          </section>
        ))}
      </div>

      <DelegationTimeline delegations={delegations} agentNames={agentNames} />

      <RevokePairButton agentNames={agentNames} onRevokeBatch={revokeBatch} onWalletRevoke={walletRevoke} />
    </Shell>
  );
}

// G-2.3b: the shell topbar owns the "Links" group title; this pair view carries its own
// section eyebrow (the pair's names) + the mode/status aside. `.ops-view` scopes OPERATE styles.
function Shell({ title = 'Pair view', aside, children }: { title?: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="ops-view" style={{ display: 'grid', gap: '1.1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.9rem', flexWrap: 'wrap' }}>
        {/* The shell topbar h1 is "Links"; the pair name is this page's entity sub-heading (h2). */}
        <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: '1.15rem', letterSpacing: '-0.01em', color: 'var(--ink)', margin: 0 }}>{title}</h2>
        {aside}
        <span style={{ flex: 1 }} />
        <span className="hash"><Link href="/links">← Links</Link></span>
      </div>
      {children}
    </div>
  );
}
