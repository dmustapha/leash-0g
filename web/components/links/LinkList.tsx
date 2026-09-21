// File: web/components/links/LinkList.tsx
// Owner's links: status, mode, handoff count, pause/resume/remove, mode toggle, and the
// entry point into each pair view. Pure component; actions bubble up.
'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { Link as AgentLink, LinkMode } from '@/lib/types';

const STATUS_PILL: Record<AgentLink['status'], string> = {
  active: 'pill-allow',
  paused: 'pill-idle',
  removed: 'pill-deny',
};

export function LinkList({
  links,
  agentNames,
  onAction,
  onModeChange,
}: {
  links: AgentLink[];
  agentNames: Record<string, string>;
  onAction: (linkId: string, action: 'pause' | 'resume' | 'remove') => Promise<void>;
  onModeChange: (linkId: string, mode: LinkMode) => Promise<void>;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(linkId: string, fn: () => Promise<void>) {
    setBusyId(linkId);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work. Try again.');
    } finally {
      setBusyId(null);
    }
  }

  if (links.length === 0) {
    return (
      <p data-testid="links-empty" style={{ color: 'var(--color-ink-dim)' }}>
        No links yet. Link two agents above so one can hand work to the other.
      </p>
    );
  }

  const name = (id: string) => agentNames[id] ?? `${id.slice(0, 8)}…`;

  return (
    <div style={{ display: 'grid', gap: '0.6rem' }} data-testid="link-list">
      {error ? (
        <p role="alert" style={{ color: 'var(--color-deny)', fontSize: '0.85rem' }}>
          {error}
        </p>
      ) : null}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.6rem' }}>
        {links.map((l) => {
          const busy = busyId === l.id;
          return (
            <li key={l.id} className="panel" data-testid={`link-row-${l.id}`} style={{ padding: '0.85rem 1rem', display: 'grid', gap: '0.6rem' }}>
              <div style={{ display: 'flex', gap: '0.7rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <Link href={`/links/${l.id}`} className="link-tx" style={{ fontSize: '0.95rem', fontFamily: 'var(--font-sans)' }}>
                  {name(l.fromAgentId)} → {name(l.toAgentId)}
                </Link>
                <span className={`pill ${STATUS_PILL[l.status]}`}>{l.status}</span>
                <span className="badge">{l.mode === 'auto' ? 'automatic' : 'supervised'}</span>
                <span className="badge" title="Handoffs sent over this link">
                  {l.delegationCount ?? 0} handoff{(l.delegationCount ?? 0) === 1 ? '' : 's'}
                </span>
              </div>
              {l.status !== 'removed' ? (
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  {l.status === 'active' ? (
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void run(l.id, () => onAction(l.id, 'pause'))} data-testid={`pause-link-${l.id}`}>
                      Pause
                    </button>
                  ) : (
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void run(l.id, () => onAction(l.id, 'resume'))} data-testid={`resume-link-${l.id}`}>
                      Resume
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={busy}
                    onClick={() => void run(l.id, () => onModeChange(l.id, l.mode === 'auto' ? 'supervised' : 'auto'))}
                    data-testid={`toggle-mode-${l.id}`}
                  >
                    {l.mode === 'auto' ? 'Require my approval' : 'Make automatic'}
                  </button>
                  <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => void run(l.id, () => onAction(l.id, 'remove'))} data-testid={`remove-link-${l.id}`}>
                    Remove
                  </button>
                </div>
              ) : (
                <p style={{ fontSize: '0.8rem', color: 'var(--color-ink-faint)' }}>
                  Removed links stay for your records. Create a new link to reconnect these agents.
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
