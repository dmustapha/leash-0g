// File: web/components/fleet/FleetList.tsx
// Home fleet list (spec §3c): every agent the owner has, newest first, with status,
// balance, and created date. Pure component — data and paging bubble up via props.
'use client';

import Link from 'next/link';
import type { AgentSummary } from '@/lib/types';
import { shortAddr, weiToOg } from '@/lib/format';

const STATUS_PILL: Record<AgentSummary['status'], string> = {
  active: 'pill-allow',
  revoked: 'pill-deny',
};

export function FleetList({
  agents,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  agents: AgentSummary[];
  hasMore: boolean;
  loadingMore?: boolean;
  onLoadMore: () => void;
}) {
  if (agents.length === 0) {
    return (
      <div className="panel" data-testid="fleet-empty" style={{ padding: '1.4rem', display: 'grid', gap: '0.8rem', justifyItems: 'start' }}>
        <p style={{ color: 'var(--color-ink-dim)' }}>
          No agents yet. Create your first one — it takes about a minute.
        </p>
        <Link href="/create" className="btn btn-primary">
          Create your agent
        </Link>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: '0.7rem' }} data-testid="fleet-list">
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.6rem' }}>
        {agents.map((a) => (
          <li key={a.agentId}>
            <Link
              href={`/agents/${a.agentId}`}
              className="panel card-hover"
              data-testid={`fleet-row-${a.agentId}`}
              style={{ display: 'flex', gap: '0.8rem', alignItems: 'center', padding: '0.85rem 1rem', flexWrap: 'wrap' }}
            >
              <span style={{ fontWeight: 600, minWidth: '8rem' }}>{a.name}</span>
              <span className={`pill ${STATUS_PILL[a.status]}`}>{a.status}</span>
              <span style={{ flex: 1 }} />
              <span className="badge" title={`Account ${a.accountAddr}`}>
                {weiToOg(a.accountBalanceWei)} 0G · {shortAddr(a.accountAddr)}
              </span>
              <span style={{ fontSize: '0.78rem', color: 'var(--color-ink-faint)', fontFamily: 'var(--font-mono)' }}>
                created {new Date(a.createdAt).toLocaleDateString()}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {hasMore ? (
        <div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onLoadMore}
            disabled={loadingMore}
            data-testid="fleet-load-more"
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
