// File: web/app/app/page.tsx
// The console home (route: /app): the FLEET LIST (spec §3c) — every agent the owner has, via GET /api/agents.
// The Phase-1 single localStorage agent simply appears in the fetched list; the old
// localStorage redirect behavior is dropped (the id stays readable for nav continuity).
'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { makeApi } from '@/lib/api';
import { useOwnerWallet } from '@/lib/owner-wallet';
import type { AgentSummary } from '@/lib/types';
import { FleetList } from '@/components/fleet/FleetList';

// Deep-link entry (Stage D): the Telegram JIT card links to /app?agent=<id>&jit=<requestId>.
// Route straight to that agent's cockpit, carrying ?jit so the cockpit focuses the JIT
// card. A missing agent id just falls through to the fleet list (no crash). useSearchParams
// must sit under a Suspense boundary (Next 15 CSR-bailout requirement), so it lives here.
function DeepLinkRedirect(): null {
  const router = useRouter();
  const searchParams = useSearchParams();
  useEffect(() => {
    const agent = searchParams.get('agent');
    if (!agent) return;
    const jit = searchParams.get('jit');
    router.replace(`/agents/${encodeURIComponent(agent)}${jit ? `?jit=${encodeURIComponent(jit)}` : ''}`);
  }, [router, searchParams]);
  return null;
}

export default function HomePage() {
  const wallet = useOwnerWallet();
  const api = useMemo(() => makeApi(wallet.getToken), [wallet.getToken]);

  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const loadFirst = useCallback(async () => {
    setError(null);
    try {
      const res = await api.listAgents();
      setAgents(res.agents);
      setNextCursor(res.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your agents.');
    }
  }, [api]);

  useEffect(() => {
    if (wallet.authenticated) void loadFirst();
  }, [wallet.authenticated, loadFirst]);

  const loadMore = useCallback(async () => {
    if (nextCursor === undefined) return;
    setLoadingMore(true);
    try {
      const res = await api.listAgents(nextCursor);
      setAgents((prev) => [...(prev ?? []), ...res.agents]);
      setNextCursor(res.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load more agents.');
    } finally {
      setLoadingMore(false);
    }
  }, [api, nextCursor]);

  return (
    <div className="wrap" style={{ paddingBlock: 'clamp(2rem, 6vw, 4rem)', display: 'grid', gap: '1.4rem' }}>
      <Suspense fallback={null}>
        <DeepLinkRedirect />
      </Suspense>
      <section className="rise" style={{ display: 'grid', gap: '1rem', maxWidth: '44rem' }}>
        <p className="eyebrow">LEASH on 0G · phase 2</p>
        <h1 style={{ fontSize: 'var(--text-display)' }}>Your AI agents, on leashes you can pull.</h1>
        <p style={{ color: 'var(--color-ink-dim)', fontSize: '1.05rem' }}>
          Create agents with hard spending limits, link them so one can hand work to another,
          watch their thinking live, and cut any of them off in one move.
        </p>
      </section>

      {!wallet.ready ? (
        <p role="status" style={{ color: 'var(--color-ink-dim)' }}>Loading…</p>
      ) : !wallet.authenticated ? (
        <div className="card" style={{ padding: '1.4rem', display: 'grid', gap: '0.8rem', justifyItems: 'start' }}>
          <p>Connect your wallet to see your agents.</p>
          <button type="button" className="btn btn-primary" onClick={wallet.login}>
            Connect wallet
          </button>
        </div>
      ) : (
        <section aria-label="Your agents" style={{ display: 'grid', gap: '0.9rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            <h2 style={{ fontSize: 'var(--text-h2)' }}>Your agents</h2>
            <span style={{ flex: 1 }} />
            <Link href="/create" className="btn btn-primary btn-sm">
              Create agent
            </Link>
            <Link href="/links" className="btn btn-ghost btn-sm">
              Links
            </Link>
          </div>
          {error ? (
            <div className="toast toast-err" role="alert">
              <p>We could not load your agents ({error}).</p>
              <button type="button" className="btn btn-sm" onClick={() => void loadFirst()}>
                Retry
              </button>
            </div>
          ) : agents === null ? (
            <p role="status" style={{ color: 'var(--color-ink-dim)' }}>Loading your agents…</p>
          ) : (
            <FleetList
              agents={agents}
              hasMore={nextCursor !== undefined}
              loadingMore={loadingMore}
              onLoadMore={() => void loadMore()}
            />
          )}
        </section>
      )}
    </div>
  );
}
