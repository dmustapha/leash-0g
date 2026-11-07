// File: web/app/app/page.tsx
// The console home (route: /app): the FLEET — every agent the owner has, via GET /api/agents,
// reskinned to the owner-locked design (console.html data-view="fleet"). STAGE G-2.2.
//
// The page title ("Fleet") now lives in the shell topbar (AppShell), so this view goes
// straight to the summary strip + agent card grid — no page-level hero (that old marketing
// hero is what made /app look like the landing; it's gone). Live-data: listAgents + getDigest
// fetched together; the digest feeds the per-agent meter/facts and the four summary tiles.
'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { makeApi } from '@/lib/api';
import { useOwnerWallet } from '@/lib/owner-wallet';
import type { AgentSummary, AgentDigest, AssetBucket } from '@/lib/types';
import { formatBuckets } from '@/lib/asset';
import { FleetList } from '@/components/fleet/FleetList';

// Deep-link entry (Stage D): the Telegram JIT card links to /app?agent=<id>&jit=<requestId>.
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

type SummaryTile = { k: string; v: React.ReactNode; cls?: string; live?: boolean };

/** Beta step 3b: per-asset, never one summed number across assets ("1.02 NOVL · <0.000001 0G"). */
function spentTodayLabel(digest: { totals?: { spendByAsset?: AssetBucket[] } } | null | undefined): string {
  const buckets = digest?.totals?.spendByAsset;
  if (!buckets) return '0';
  const label = formatBuckets(buckets);
  return label === 'nothing' ? '0' : label;
}

function FleetSummary({ agents, digest }: { agents: AgentSummary[]; digest: { totals?: { spendWei: string; spendByAsset?: AssetBucket[]; actions: number }; agents?: AgentDigest[] } | null }) {
  const active = agents.filter((a) => a.status !== 'revoked').length;
  const blocked = (digest?.agents ?? []).reduce((s, d) => s + (d.blocks ?? 0), 0);
  // The artifact's four tiles, reconciled to real digest aggregates. "Daily headroom" needs
  // per-agent caps (AgentDetail, not the fleet list) → shown as "Actions today" instead, the
  // real fleet-activity figure the digest does carry.
  const tiles: SummaryTile[] = [
    { k: 'Agents on a leash', v: <>{active}<small> / {agents.length}</small></> },
    { k: 'Spent today', v: spentTodayLabel(digest), cls: 'allow', live: true },
    { k: 'Blocked today', v: blocked, cls: blocked > 0 ? 'deny' : undefined },
    { k: 'Actions today', v: digest?.totals?.actions ?? 0, cls: 'accent' },
  ];
  return (
    <div className="fleet-summary">
      {tiles.map((t) => (
        <div className="sum" key={t.k} {...(t.live ? { 'aria-live': 'polite' } : {})}>
          <div className="k">{t.k}</div>
          <div className={`v${t.cls ? ` ${t.cls}` : ''}`}>{t.v}</div>
        </div>
      ))}
    </div>
  );
}

function FleetSkeleton() {
  return (
    <div className="fleet" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div className="skel-card" key={i}>
          <div className="skel skel-line" style={{ width: '45%' }} />
          <div className="skel skel-line" style={{ width: '30%', height: 9 }} />
          <div className="skel skel-line" style={{ width: '100%', height: 44, margin: '16px 0' }} />
          <div className="skel skel-line" style={{ width: '80%' }} />
        </div>
      ))}
    </div>
  );
}

export default function HomePage() {
  const wallet = useOwnerWallet();
  const api = useMemo(() => makeApi(wallet.getToken), [wallet.getToken]);

  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [digest, setDigest] = useState<{ totals?: { spendWei: string; actions: number }; agents?: AgentDigest[] } | null>(null);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const loadFirst = useCallback(async () => {
    setError(null);
    try {
      // The fleet list is required; the digest is best-effort (it only enriches the cards +
      // tiles, so a digest failure must not blank the fleet). Hence settle, not all.
      const [agentsRes, digestRes] = await Promise.allSettled([api.listAgents(), api.getDigest()]);
      if (agentsRes.status === 'rejected') throw agentsRes.reason;
      setAgents(agentsRes.value.agents);
      setNextCursor(agentsRes.value.nextCursor);
      setDigest(digestRes.status === 'fulfilled' ? digestRes.value.digest : null);
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

  const digestByAgent = useMemo(() => {
    const map: Record<string, AgentDigest | undefined> = {};
    for (const d of digest?.agents ?? []) map[d.agentId] = d;
    return map;
  }, [digest]);

  return (
    <>
      <Suspense fallback={null}>
        <DeepLinkRedirect />
      </Suspense>

      {!wallet.ready ? (
        <p role="status" style={{ color: 'var(--ink-dim)' }}>
          Loading…
        </p>
      ) : !wallet.authenticated ? (
        <div className="deadstate">
          <svg className="leash-svg" viewBox="0 0 80 44" aria-hidden="true">
            <circle className="leash-clasp" cx="10" cy="22" r="6" />
            <path className="leash-path" d="M16 22 Q 40 30 74 22" />
          </svg>
          <h4>Connect your wallet</h4>
          <p>Sign in to see your fleet — every agent, its balance, and what it spent today.</p>
          <button type="button" className="btn btn-primary" onClick={wallet.login}>
            Connect wallet
          </button>
        </div>
      ) : error ? (
        <div className="deadstate error" role="alert">
          <h4>Could not load your fleet</h4>
          <p>{error}</p>
          <button type="button" className="btn btn-ghost" onClick={() => void loadFirst()}>
            Retry
          </button>
        </div>
      ) : agents === null ? (
        <>
          <div className="fleet-summary" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <div className="skel-card" key={i} style={{ padding: 'var(--s-4) var(--s-5)' }}>
                <div className="skel skel-line" style={{ width: '60%', height: 9 }} />
                <div className="skel skel-line" style={{ width: '40%', height: 22, marginTop: 10, marginBottom: 0 }} />
              </div>
            ))}
          </div>
          <FleetSkeleton />
        </>
      ) : (
        <section aria-label="Your fleet">
          <FleetSummary agents={agents} digest={digest} />
          {/* The reference fleet is a static demo with no create affordance; the live app
              must reach creation from the fleet, so the section header carries it. */}
          <div className="fleet-head">
            <p className="section-title" style={{ margin: 0 }}>
              Agents · <span className="n">{agents.filter((a) => a.status !== 'revoked').length} on a leash</span>
            </p>
            <span className="grow" />
            <Link href="/create" className="btn btn-primary btn-sm">
              Create agent
            </Link>
          </div>
          <FleetList
            agents={agents}
            digestByAgent={digestByAgent}
            hasMore={nextCursor !== undefined}
            loadingMore={loadingMore}
            onLoadMore={() => void loadMore()}
          />
        </section>
      )}
    </>
  );
}
