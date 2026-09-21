// File: web/components/inbox/InboxView.tsx
// Alert inbox (spec §3c): newest-first list with class/kind/agent filters, unread badge and
// "Mark all read". Pure-ish component — data + actions are injected so it stays testable; the
// page wires it to the API and the live owner stream.
'use client';

import { useMemo, useState } from 'react';
import type { Alert, AlertClass, AlertKind } from '@/lib/types';
import { AlertCard } from './AlertCard';

const KIND_OPTIONS: Array<{ value: AlertKind; label: string }> = [
  { value: 'approval_required', label: 'Needs decision' },
  { value: 'limit_hit', label: 'Limit reached' },
  { value: 'revoked', label: 'Revoked' },
  { value: 'revoke_failed', label: 'Revoke failed' },
  { value: 'delegation_terminal', label: 'Handoff ended' },
  { value: 'runtime_error', label: 'Agent errors' },
  { value: 'throttle', label: 'Throttled' },
  { value: 'alert_storm', label: 'Alert storm' },
];

export function InboxView({
  alerts,
  unread,
  agents,
  onDecide,
  onDismiss,
  onMarkAllRead,
}: {
  alerts: Alert[];
  unread: number;
  /** id → display name, for the agent filter + card context. */
  agents: Array<{ agentId: string; name: string }>;
  onDecide: (approvalId: string, decision: 'approve' | 'deny') => Promise<void>;
  onDismiss: (alertId: string) => Promise<void>;
  onMarkAllRead: () => Promise<void>;
}) {
  const [klass, setKlass] = useState<'all' | AlertClass>('all');
  const [kind, setKind] = useState<'all' | AlertKind>('all');
  const [agentId, setAgentId] = useState<string>('all');
  const [marking, setMarking] = useState(false);

  const filtered = useMemo(
    () =>
      [...alerts]
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .filter((a) => klass === 'all' || a.class === klass)
        .filter((a) => kind === 'all' || a.kind === kind)
        .filter((a) => agentId === 'all' || a.agentId === agentId),
    [alerts, klass, kind, agentId],
  );

  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem', flexWrap: 'wrap' }}>
        {unread > 0 ? (
          <span className="pill pill-accent" data-testid="inbox-unread-pill">
            {unread} unread
          </span>
        ) : (
          <span className="pill pill-idle" data-testid="inbox-caught-up-pill">
            All caught up
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={marking}
          data-testid="mark-all-read-btn"
          onClick={() => {
            setMarking(true);
            void onMarkAllRead().finally(() => setMarking(false));
          }}
        >
          {marking ? 'Marking…' : 'Mark all read'}
        </button>
      </div>

      <div role="group" aria-label="Filter alerts" style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
        <label style={{ display: 'grid', gap: '0.25rem' }}>
          <span className="label">Type</span>
          <select
            className="field"
            value={klass}
            data-testid="filter-class"
            onChange={(e) => setKlass(e.target.value as 'all' | AlertClass)}
          >
            <option value="all">All</option>
            <option value="decision">Needs you</option>
            <option value="info">For your information</option>
          </select>
        </label>
        <label style={{ display: 'grid', gap: '0.25rem' }}>
          <span className="label">What happened</span>
          <select
            className="field"
            value={kind}
            data-testid="filter-kind"
            onChange={(e) => setKind(e.target.value as 'all' | AlertKind)}
          >
            <option value="all">Everything</option>
            {KIND_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'grid', gap: '0.25rem' }}>
          <span className="label">Agent</span>
          <select
            className="field"
            value={agentId}
            data-testid="filter-agent"
            onChange={(e) => setAgentId(e.target.value)}
          >
            <option value="all">All agents</option>
            {agents.map((a) => (
              <option key={a.agentId} value={a.agentId}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {filtered.length === 0 ? (
        <p style={{ color: 'var(--color-ink-faint)', fontSize: '0.92rem' }} data-testid="inbox-empty">
          Nothing here. When an agent needs you — or something worth knowing happens — it lands
          in this inbox.
        </p>
      ) : (
        <div style={{ display: 'grid', gap: '0.7rem' }} data-testid="inbox-list">
          {filtered.map((a) => (
            <AlertCard key={a.id} alert={a} onDecide={onDecide} onDismiss={onDismiss} />
          ))}
        </div>
      )}
    </div>
  );
}
