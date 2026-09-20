// File: web/components/cockpit/ApprovalCard.tsx
// Pending-approval card: the boundary decision surfaced to the owner. Approve / Deny with an
// optional reason. Pure component — decisions bubble up via onDecide.
'use client';

import { useState } from 'react';
import type { StreamEvent } from '@/lib/types';
import { weiToOg, shortAddr } from '@/lib/format';

type Approval = Extract<StreamEvent, { type: 'approval' }>;

export function ApprovalCard({
  approval,
  onDecide,
}: {
  approval: Approval;
  onDecide: (decision: 'approve' | 'deny', reason?: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: 'approve' | 'deny') {
    setBusy(decision);
    setError(null);
    try {
      await onDecide(decision, reason.trim() || undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send your decision. Try again.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      aria-label="Approval needed"
      className="raised"
      data-testid="approval-card"
      style={{ padding: '1rem 1.1rem', display: 'grid', gap: '0.7rem', borderColor: 'rgba(198,242,77,0.45)' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <span className="pill pill-accent">Needs your decision</span>
      </div>
      <p style={{ fontSize: '0.95rem' }}>{approval.summary}</p>
      {approval.to || approval.valueWei ? (
        <p className="code">
          {approval.valueWei ? `${weiToOg(approval.valueWei)} 0G` : ''}
          {approval.to ? ` → ${shortAddr(approval.to)}` : ''}
        </p>
      ) : null}
      <div style={{ display: 'grid', gap: '0.35rem' }}>
        <label htmlFor={`reason-${approval.approvalId}`} className="label">
          Reason (optional)
        </label>
        <input
          id={`reason-${approval.approvalId}`}
          className="field"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why you decided this way"
          disabled={busy !== null}
        />
      </div>
      {error ? (
        <p role="alert" style={{ color: 'var(--color-deny)', fontSize: '0.84rem' }}>
          {error}
        </p>
      ) : null}
      <div style={{ display: 'flex', gap: '0.6rem' }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy !== null}
          onClick={() => void decide('approve')}
          data-testid="approve-btn"
        >
          {busy === 'approve' ? 'Approving…' : 'Approve'}
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={busy !== null}
          onClick={() => void decide('deny')}
          data-testid="deny-btn"
        >
          {busy === 'deny' ? 'Denying…' : 'Deny'}
        </button>
      </div>
    </section>
  );
}
