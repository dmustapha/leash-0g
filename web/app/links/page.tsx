// File: web/app/links/page.tsx
// Links page (spec §3c): create a link between two owner agents, list and manage links.
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { makeApi } from '@/lib/api';
import { useOwnerWallet } from '@/lib/owner-wallet';
import type { AgentSummary, Link as AgentLink, LinkMode } from '@/lib/types';
import { LinkCreateForm } from '@/components/links/LinkCreateForm';
import { LinkList } from '@/components/links/LinkList';

export default function LinksPage() {
  const wallet = useOwnerWallet();
  const api = useMemo(() => makeApi(wallet.getToken), [wallet.getToken]);

  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [links, setLinks] = useState<AgentLink[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [agentsRes, linksRes] = await Promise.all([api.listAgents(), api.listLinks()]);
      setAgents(agentsRes.agents);
      setLinks(linksRes.links);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your links.');
    }
  }, [api]);

  useEffect(() => {
    if (wallet.authenticated) void refresh();
  }, [wallet.authenticated, refresh]);

  const agentNames = useMemo(
    () => Object.fromEntries(agents.map((a) => [a.agentId, a.name])),
    [agents],
  );

  const createLink = useCallback(
    async (body: { fromAgentId: string; toAgentId: string; mode: LinkMode }) => {
      await api.createLink(body);
      await refresh();
    },
    [api, refresh],
  );

  const linkAction = useCallback(
    async (linkId: string, action: 'pause' | 'resume' | 'remove') => {
      await api.updateLink(linkId, { action });
      await refresh();
    },
    [api, refresh],
  );

  const modeChange = useCallback(
    async (linkId: string, mode: LinkMode) => {
      await api.updateLink(linkId, { mode });
      await refresh();
    },
    [api, refresh],
  );

  return (
    <div className="wrap" style={{ paddingBlock: 'clamp(1.5rem, 4vw, 3rem)', display: 'grid', gap: '1.1rem' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '1rem' }}>
        <h1 style={{ fontSize: 'var(--text-h1)' }}>Links</h1>
        <span style={{ flex: 1 }} />
        <Link href="/" className="nav-link">
          ← Your agents
        </Link>
      </div>

      {!wallet.ready ? (
        <p role="status" style={{ color: 'var(--color-ink-dim)' }}>Loading…</p>
      ) : !wallet.authenticated ? (
        <div className="card" style={{ padding: '1.4rem', display: 'grid', gap: '0.8rem', justifyItems: 'start' }}>
          <p>Connect your wallet to manage links between your agents.</p>
          <button type="button" className="btn btn-primary" onClick={wallet.login}>
            Connect wallet
          </button>
        </div>
      ) : error ? (
        <div className="toast toast-err" role="alert">
          <p>We could not load your links ({error}).</p>
          <button type="button" className="btn btn-sm" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      ) : links === null ? (
        <p role="status" style={{ color: 'var(--color-ink-dim)' }}>Loading your links…</p>
      ) : (
        <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))', alignItems: 'start' }}>
          <LinkCreateForm agents={agents} onCreate={createLink} />
          <section aria-label="Your links" style={{ display: 'grid', gap: '0.7rem' }}>
            <h2 style={{ fontSize: '1rem' }}>Your links</h2>
            <LinkList links={links} agentNames={agentNames} onAction={linkAction} onModeChange={modeChange} />
          </section>
        </div>
      )}
    </div>
  );
}
