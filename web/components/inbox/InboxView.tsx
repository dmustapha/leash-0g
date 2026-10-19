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

  const nameById = useMemo(() => {
    const m: Record<string, string> = {};
    for (const a of agents) m[a.agentId] = a.name;
    return m;
  }, [agents]);

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
    <div>
      {/* reference toolbar (console.html:497-502) — "Attention queue · N unread" + Mark all read */}
      <div className="view-toolbar">
        <span className="section-title" style={{ margin: 0 }} data-testid={unread > 0 ? 'inbox-unread-pill' : 'inbox-caught-up-pill'}>
          Attention queue · <span className="n">{unread > 0 ? `${unread} unread` : 'all caught up'}</span>
        </span>
        <span className="grow" />
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

      <div className="filters" role="group" aria-label="Filter alerts">
        <label>
          <span className="label">Type</span>
          <select value={klass} data-testid="filter-class" onChange={(e) => setKlass(e.target.value as 'all' | AlertClass)}>
            <option value="all">All</option>
            <option value="decision">Needs you</option>
            <option value="info">For your information</option>
          </select>
        </label>
        <label>
          <span className="label">What happened</span>
          <select value={kind} data-testid="filter-kind" onChange={(e) => setKind(e.target.value as 'all' | AlertKind)}>
            <option value="all">Everything</option>
            {KIND_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">Agent</span>
          <select value={agentId} data-testid="filter-agent" onChange={(e) => setAgentId(e.target.value)}>
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
        <div className="deadstate" data-testid="inbox-empty">
          <svg className="leash-svg" viewBox="0 0 80 44" aria-hidden="true">
            <circle className="leash-clasp" cx="10" cy="22" r="6" />
            <path className="leash-path" d="M16 22 Q 40 30 74 22" />
          </svg>
          <h4>All caught up</h4>
          <p>When an agent needs you — or something worth knowing happens — it lands here.</p>
        </div>
      ) : (
        <div aria-live="polite" data-testid="inbox-list">
          {filtered.map((a) => (
            <AlertCard
              key={a.id}
              alert={a}
              agentName={a.agentId ? nameById[a.agentId] : undefined}
              onDecide={onDecide}
              onDismiss={onDismiss}
            />
          ))}
        </div>
      )}
    </div>
  );
}
