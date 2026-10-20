// File: web/components/inbox/AlertCard.tsx
// STAGE G-2.2 — restyled to the owner-locked `.alert` design (console.html:321-336, alertCard
// renderer :1082-1091): kind-chip | a-body | a-actions. The DESIGN is the artifact's; all the
// real behaviour the artifact's demo lacks is kept intact —
//  - approval_required (decision): inline Approve/Deny — same approval rails as the cockpit
//    (POST /api/approvals/:id). Never dismissible.
//  - limit_hit (decision): plain-language decoded-error copy, Adjust deep-link, "resets in".
//  - revoke_failed: steer CTA to the agent page (owner-wallet fallback).
//  - other info kinds: dismissible, coalesced ×N.
// Every test id is preserved so the inbox e2e stays green.
'use client';

import { useEffect, useState } from 'react';
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
  agentName,
  onDecide,
  onDismiss,
}: {
  alert: Alert;
  /** optional display name for the a-head (InboxView resolves it from the agent list). */
  agentName?: string;
  onDecide: (approvalId: string, decision: 'approve' | 'deny') => Promise<void>;
  onDismiss: (alertId: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState<'approve' | 'deny' | 'dismiss' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = alert.status === 'unread' || alert.status === 'read';
  const unread = alert.status === 'unread';
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
  const autoDeniesAt = typeof alert.refs.autoDeniesAtUnix === 'number' ? alert.refs.autoDeniesAtUnix : undefined;
  const sessionExpired = alert.refs.errorName === 'SessionExpired';

  const [, setTick] = useState(0);
  useEffect(() => {
    if (clearsAt === undefined && autoDeniesAt === undefined) return;
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [clearsAt, autoDeniesAt]);

  return (
    <article
      aria-label={KIND_LABEL[alert.kind]}
      className={`alert${isDecision ? ' decision' : ''} ${open ? (unread ? 'unread' : 'read') : 'read'}`}
      data-testid={`alert-${alert.id}`}
    >
      <span className={`kind-chip ${alert.kind}`}>{alert.kind.replace(/_/g, ' ')}</span>

      <div className="a-body">
        <div className="a-head">
          <span className="a-agent">{agentName ?? KIND_LABEL[alert.kind]}</span>
          {alert.count > 1 ? (
            <span className="badge-pill" data-testid="alert-count" title={`${alert.count} occurrences, coalesced`}>
              ×{alert.count}
            </span>
          ) : null}
          {unread ? <span className="dot-live" role="img" aria-label="unread" data-testid="alert-unread-dot" /> : null}
          {isDecision && open ? <span className="unverified">Untrusted intent</span> : null}
        </div>

        <p className="a-intent">{alert.summary}</p>

        {typeof alert.refs.agentIntent === 'string' && alert.refs.agentIntent ? (
          <div className="a-sub" data-testid="agent-intent">
            <span className="a-sub-k">Agent says · unverified</span>
            <span className="a-sub-v">“{alert.refs.agentIntent}”</span>
          </div>
        ) : null}

        {open && alert.kind === 'approval_required' && autoDeniesAt !== undefined ? (
          <div className="a-meta" data-testid="autodeny-countdown">
            {countdown(autoDeniesAt) === 'expired'
              ? 'Time is up — this is denying by default.'
              : `Denies by default in ${countdown(autoDeniesAt)} if you don't answer.`}
          </div>
        ) : null}

        {alert.kind === 'limit_hit' && decodedPlain ? (
          <div style={{ display: 'grid', gap: '0.4rem', marginTop: '6px' }}>
            <p className="a-intent" data-testid="decoded-plain" style={{ margin: 0 }}>
              {decodedPlain}
            </p>
            {clearsAt !== undefined ? (
              <div className="a-meta" data-testid="limit-countdown">
                {countdown(clearsAt) === 'expired'
                  ? 'The limit has reset — the agent can act again.'
                  : `Resets in ${countdown(clearsAt)} (at ${new Date(clearsAt * 1000).toLocaleTimeString()}).`}
              </div>
            ) : null}
            <Disclosure label="Technical detail">
              Contract error: <code className="code">{alert.refs.errorName}</code>
            </Disclosure>
          </div>
        ) : null}

        {!open && alert.resolution ? (
          <p
            className={`chip ${alert.resolution === 'approve' ? 'chip-allow' : alert.resolution === 'deny' ? 'chip-deny' : 'chip-pend'}`}
            style={{ justifySelf: 'start', marginTop: '6px' }}
            data-testid="alert-resolution"
          >
            {RESOLUTION_LABEL[alert.resolution]}
            {alert.resolvedVia === 'telegram' ? ' · via Telegram' : ''}
          </p>
        ) : null}

        {error ? (
          <p role="alert" style={{ color: 'var(--deny)', fontSize: '0.84rem', margin: '6px 0 0' }}>
            {error}
          </p>
        ) : null}

        <div className="a-meta">
          <span>{new Date(alert.createdAt).toLocaleString()}</span>
        </div>
      </div>

      {open ? (
        <div className="a-actions">
          {alert.kind === 'approval_required' && alert.refs.approvalId ? (
            <>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={busy !== null}
                data-testid="alert-approve-btn"
                onClick={() => void run('approve', () => onDecide(alert.refs.approvalId as string, 'approve'))}
              >
                {busy === 'approve' ? 'Approving…' : 'Approve'}
              </button>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                disabled={busy !== null}
                data-testid="alert-deny-btn"
                onClick={() => void run('deny', () => onDecide(alert.refs.approvalId as string, 'deny'))}
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
