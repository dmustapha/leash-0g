// File: web/app/links/page.tsx
// Links page (spec §3c): create a link between two owner agents, list and manage links.
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
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

  // G-2.3b: the shell topbar owns the "Links" title; `.ops-view` scopes the OPERATE styles.
  return (
    <div className="ops-view">
      <p className="section-title">
        Agent-to-agent links · <span className="n">delegation pairs</span>
      </p>

      {!wallet.ready ? (
        <p role="status" style={{ color: 'var(--ink-dim)' }}>Loading…</p>
      ) : !wallet.authenticated ? (
        <div className="deadstate">
          <svg className="leash-svg" viewBox="0 0 80 44" aria-hidden="true">
            <circle className="leash-clasp" cx="10" cy="22" r="6" />
            <path className="leash-path" d="M16 22 Q 40 30 74 22" />
          </svg>
          <h4>Connect your wallet</h4>
          <p>Sign in to manage links — the channels one agent uses to hand work to another.</p>
          <button type="button" className="btn btn-primary" onClick={wallet.login}>
            Connect wallet
          </button>
        </div>
      ) : error ? (
        <div className="deadstate error" role="alert">
          <h4>Could not load your links</h4>
          <p>{error}</p>
          <button type="button" className="btn btn-ghost" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      ) : links === null ? (
        <p role="status" style={{ color: 'var(--ink-dim)' }}>Loading your links…</p>
      ) : (
        <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))', alignItems: 'start' }}>
          <LinkCreateForm agents={agents} onCreate={createLink} />
          <section aria-label="Your links" style={{ display: 'grid', gap: '0.7rem' }}>
            <p className="section-title" style={{ margin: 0 }}>Your links</p>
            <LinkList links={links} agentNames={agentNames} onAction={linkAction} onModeChange={modeChange} />
          </section>
        </div>
      )}
    </div>
  );
}
