// File: web/components/inbox/AlertCard.tsx
// One alert, rendered by kind (spec §3b taxonomy):
//  - approval_required (decision): inline Approve/Deny — the SAME approval rails as the
//    cockpit's ApprovalCard (POST /api/approvals/:id). Never dismissible (server 409s).
//  - limit_hit (decision): plain-language decoded-error copy, Adjust deep-link to the policy
//    panel (re-arm for SessionExpired), "resets in" countdown, Dismiss.
//  - revoke_failed: steer CTA to the agent page (owner-wallet fallback lives there).
//  - other info kinds: dismissible, coalesced count shown as ×N.
// Pure component — decisions and dismissals bubble up via callbacks.
'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { Alert } from '@/lib/types';
import { countdown } from '@/lib/format';
import { plainLeashError } from '@/lib/leash-errors';
import { Disclosure } from '@/components/ui/Disclosure';

const KIND_LABEL: Record<Alert['kind'], string> = {
  approval_required: 'Needs your decision',
  limit_hit: 'Limit reached',
  revoked: 'Agent revoked',
  revoke_failed: 'Revoke failed',
  delegation_terminal: 'Handoff ended',
  runtime_error: 'Agent errors',
  throttle: 'Requests throttled',
  alert_storm: 'Alert storm contained',
};

const RESOLUTION_LABEL: Record<NonNullable<Alert['resolution']>, string> = {
  approve: 'Approved',
  deny: 'Denied',
  expired: 'Expired without a decision',
  dismissed: 'Dismissed',
};

export function AlertCard({
  alert,
  onDecide,
  onDismiss,
}: {
  alert: Alert;
  /** Same rails as the cockpit ApprovalCard — POST /api/approvals/:id upstream. */
  onDecide: (approvalId: string, decision: 'approve' | 'deny') => Promise<void>;
  onDismiss: (alertId: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState<'approve' | 'deny' | 'dismiss' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = alert.status === 'unread' || alert.status === 'read';
  const isDecision = alert.class === 'decision';
  const dismissible = open && alert.kind !== 'approval_required';

  async function run(kind: 'approve' | 'deny' | 'dismiss', fn: () => Promise<void>) {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not go through. Try again.');
    } finally {
      setBusy(null);
    }
  }

  const decodedPlain = alert.refs.errorName ? plainLeashError(alert.refs.errorName) : null;
  const clearsAt = alert.refs.boundaryClearsAtUnix;
  const sessionExpired = alert.refs.errorName === 'SessionExpired';

  return (
    <article
      aria-label={KIND_LABEL[alert.kind]}
      className={isDecision && open ? 'raised' : 'panel'}
      data-testid={`alert-${alert.id}`}
      style={{
        padding: '0.9rem 1.05rem',
        display: 'grid',
        gap: '0.6rem',
        ...(isDecision && open ? { borderColor: 'rgba(198,242,77,0.45)' } : {}),
        ...(open ? {} : { opacity: 0.75 }),
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', flexWrap: 'wrap' }}>
        <span className={isDecision && open ? 'pill pill-accent' : 'pill pill-idle'}>
          {KIND_LABEL[alert.kind]}
        </span>
        {alert.count > 1 ? (
          <span className="badge" data-testid="alert-count" title={`${alert.count} occurrences, coalesced`}>
            ×{alert.count}
          </span>
        ) : null}
        {alert.status === 'unread' ? (
          <span className="dot-live" role="img" aria-label="unread" data-testid="alert-unread-dot" />
        ) : null}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: '0.76rem', color: 'var(--color-ink-faint)' }}>
          {new Date(alert.createdAt).toLocaleString()}
        </span>
      </div>

      <p style={{ fontSize: '0.92rem', margin: 0 }}>{alert.summary}</p>

      {alert.kind === 'limit_hit' && decodedPlain ? (
        <div style={{ display: 'grid', gap: '0.4rem' }}>
          <p style={{ fontSize: '0.86rem', color: 'var(--color-ink-dim)', margin: 0 }} data-testid="decoded-plain">
            {decodedPlain}
          </p>
          {clearsAt !== undefined ? (
            <p style={{ fontSize: '0.84rem', margin: 0 }} data-testid="limit-countdown">
              {countdown(clearsAt) === 'expired'
                ? 'The limit has reset — the agent can act again.'
                : `Resets in ${countdown(clearsAt)} (at ${new Date(clearsAt * 1000).toLocaleTimeString()}).`}
            </p>
          ) : null}
          <Disclosure label="Technical detail">
            Contract error: <code className="code">{alert.refs.errorName}</code>
          </Disclosure>
        </div>
      ) : null}

      {!open && alert.resolution ? (
        <p
          className={`pill ${alert.resolution === 'approve' ? 'pill-allow' : alert.resolution === 'deny' ? 'pill-deny' : 'pill-idle'}`}
          style={{ justifySelf: 'start' }}
          data-testid="alert-resolution"
        >
          {RESOLUTION_LABEL[alert.resolution]}
          {alert.resolvedVia === 'telegram' ? ' · via Telegram' : ''}
        </p>
      ) : null}

      {error ? (
        <p role="alert" style={{ color: 'var(--color-deny)', fontSize: '0.84rem', margin: 0 }}>
          {error}
        </p>
      ) : null}

      {open ? (
        <div style={{ display: 'flex', gap: '0.55rem', flexWrap: 'wrap' }}>
          {alert.kind === 'approval_required' && alert.refs.approvalId ? (
            <>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={busy !== null}
                data-testid="alert-approve-btn"
                onClick={() =>
                  void run('approve', () => onDecide(alert.refs.approvalId as string, 'approve'))
                }
              >
                {busy === 'approve' ? 'Approving…' : 'Approve'}
              </button>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                disabled={busy !== null}
                data-testid="alert-deny-btn"
                onClick={() =>
                  void run('deny', () => onDecide(alert.refs.approvalId as string, 'deny'))
                }
              >
                {busy === 'deny' ? 'Denying…' : 'Deny'}
              </button>
            </>
          ) : null}
          {alert.kind === 'limit_hit' && alert.agentId ? (
            <Link
              href={`/agents/${alert.agentId}${sessionExpired ? '' : '#policy-panel'}`}
              className="btn btn-primary btn-sm"
              data-testid="alert-adjust-link"
            >
              {sessionExpired ? 'Re-arm the agent' : 'Adjust policy'}
            </Link>
          ) : null}
          {alert.kind === 'revoke_failed' && alert.agentId ? (
            <Link href={`/agents/${alert.agentId}`} className="btn btn-danger btn-sm" data-testid="alert-steer-link">
              Revoke from your wallet
            </Link>
          ) : null}
          {dismissible ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy !== null}
              data-testid="alert-dismiss-btn"
              onClick={() => void run('dismiss', () => onDismiss(alert.id))}
            >
              {busy === 'dismiss' ? 'Dismissing…' : 'Dismiss'}
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
