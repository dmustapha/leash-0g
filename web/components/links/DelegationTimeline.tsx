// File: web/components/links/DelegationTimeline.tsx
// The shared handoff timeline for a pair (spec §3c): status, kind, created/decided,
// result (tx linked to the explorer when present), per-side agent names. Live events are
// merged upstream via applyDelegationEvent; this stays a pure renderer.
'use client';

import type { Delegation, DelegationStatus } from '@/lib/types';
import type { Hex } from '@/lib/types';
import { DELEGATION_STATUS_LABEL } from '@/lib/delegations';
import { txUrl } from '@/lib/chain';

const STATUS_PILL: Record<DelegationStatus, string> = {
  pending_approval: 'pill-accent',
  pending: 'pill-idle',
  accepted: 'pill-accent',
  completed: 'pill-allow',
  failed: 'pill-deny',
  declined: 'pill-deny',
  cancelled: 'pill-idle',
  expired: 'pill-idle',
};

function resultView(result: unknown): { txHash?: Hex; text?: string } {
  if (result === null || result === undefined) return {};
  if (typeof result === 'object' && !Array.isArray(result)) {
    const tx = (result as Record<string, unknown>)['txHash'];
    if (typeof tx === 'string' && tx.startsWith('0x')) return { txHash: tx as Hex };
  }
  return { text: JSON.stringify(result) };
}

export function DelegationTimeline({
  delegations,
  agentNames,
}: {
  delegations: Delegation[];
  agentNames: Record<string, string>;
}) {
  const name = (id: string) => (id ? (agentNames[id] ?? `${id.slice(0, 8)}…`) : '…');

  return (
    <section aria-label="Handoff timeline" className="card" style={{ display: 'grid', gridTemplateRows: 'auto 1fr', minHeight: 0 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.8rem 1rem', borderBottom: '1px solid var(--color-line-soft)' }}>
        <h2 style={{ fontSize: '1rem' }}>Handoffs</h2>
        <span style={{ flex: 1 }} />
        <span className="badge">{delegations.length}</span>
      </header>
      <div aria-live="polite" data-testid="delegation-timeline" style={{ overflowY: 'auto', maxHeight: '28rem', padding: '0.9rem 1rem', display: 'grid', gap: '0.7rem', alignContent: 'start' }}>
        {delegations.length === 0 ? (
          <p style={{ color: 'var(--color-ink-faint)', fontSize: '0.9rem' }}>
            No handoffs yet. When one agent asks the other to do something, it shows up here.
          </p>
        ) : (
          delegations.map((d) => {
            const res = resultView(d.result);
            return (
              <div key={d.id} className="panel" data-testid={`delegation-${d.id}`} style={{ padding: '0.7rem 0.85rem', display: 'grid', gap: '0.45rem' }}>
                <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className={`pill ${STATUS_PILL[d.status]}`}>{DELEGATION_STATUS_LABEL[d.status]}</span>
                  <span className="badge" title="What kind of request this is">{d.kind}</span>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: '0.76rem', color: 'var(--color-ink-faint)', fontFamily: 'var(--font-mono)' }}>
                    {new Date(d.createdAt).toLocaleTimeString()}
                    {d.decidedAt ? ` → ${new Date(d.decidedAt).toLocaleTimeString()}` : ''}
                  </span>
                </div>
                <p style={{ fontSize: '0.86rem', color: 'var(--color-ink-dim)' }}>
                  {name(d.fromAgentId)} asked {name(d.toAgentId)}
                </p>
                {res.txHash ? (
                  <a className="link-tx" href={txUrl(res.txHash)} target="_blank" rel="noreferrer" data-testid={`delegation-tx-${d.id}`}>
                    view result tx
                  </a>
                ) : res.text ? (
                  <code className="code" data-testid={`delegation-result-${d.id}`}>{res.text}</code>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
