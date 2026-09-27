// File: web/components/cockpit/ChainView.tsx
// Phase 5.6 (spec §3a/§7.C) — a chain-ordered, read-only timeline: the originating
// directive → each hop (status, upstream→downstream) → terminal state. ONE chain
// as one story (not N scattered delegations). Renders GET /api/chains/:id. Every
// quarantined string (directedIntent) is PLAIN TEXT — no dangerouslySetInnerHTML.
'use client';

import type { Chain, Delegation } from '@/lib/types';

const STATUS_LABEL: Record<Chain['status'], string> = {
  planned: 'Planned — waiting for the first step',
  running: 'Running',
  completed: 'Completed',
  terminated: 'Stopped',
};

/** Plain-language name for an agent id, falling back to a short id. */
function nameOf(agentNames: Record<string, string>, id: string): string {
  return agentNames[id] ?? `${id.slice(0, 8)}…`;
}

export type ChainViewProps = {
  chain: Chain;
  hops: Delegation[];
  /** agentId → display name, for a human-readable timeline. */
  agentNames?: Record<string, string>;
};

export function ChainView({ chain, hops, agentNames = {} }: ChainViewProps) {
  return (
    <section
      data-testid="chain-view"
      aria-label="Chain timeline"
      className="card"
      style={{ padding: '1rem 1.1rem', display: 'grid', gap: '0.8rem' }}
    >
      <header style={{ display: 'grid', gap: '0.25rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h3 style={{ fontSize: '1rem', margin: 0 }}>Chain</h3>
          <span data-testid="chain-status" className="pill" style={{ fontSize: '0.78rem' }}>
            {STATUS_LABEL[chain.status]}
          </span>
        </div>
        <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--color-ink-dim)' }}>
          Starts at <strong>{nameOf(agentNames, chain.originAgentId)}</strong> · {chain.plan.length} step
          {chain.plan.length === 1 ? '' : 's'}
        </p>
      </header>

      <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.6rem' }}>
        {chain.plan.map((step, i) => {
          const hop = hops[i];
          return (
            <li key={i} data-testid={`chain-view-hop-${i}`} className="panel" style={{ padding: '0.7rem 0.8rem', display: 'grid', gap: '0.3rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.86rem', fontWeight: 600 }}>Step {i + 1}</span>
                <span data-testid={`chain-view-hop-status-${i}`} className="pill" style={{ fontSize: '0.74rem' }}>
                  {hop ? hop.status : 'not yet started'}
                </span>
              </div>
              {hop ? (
                <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--color-ink-dim)' }}>
                  {nameOf(agentNames, hop.fromAgentId)} → {nameOf(agentNames, hop.toAgentId)}
                </p>
              ) : (
                <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--color-ink-dim)' }}>
                  can hand off to {step.eligibleTargetIds.map((id) => nameOf(agentNames, id)).join(', ')}
                </p>
              )}
              {/* directedIntent is owner-authored but rendered as PLAIN TEXT (quarantine discipline). */}
              <p data-testid={`chain-view-intent-${i}`} style={{ margin: 0, fontSize: '0.82rem' }}>
                “{step.directedIntent}”
              </p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
