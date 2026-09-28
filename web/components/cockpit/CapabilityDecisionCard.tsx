// File: web/components/cockpit/CapabilityDecisionCard.tsx
// Stage-D JIT decision card: the agent tried something outside its standing permissions and
// paused to ask you. Mirrors ApprovalCard's plain-text, UNVERIFIED-labeled discipline. Three
// choices, each ≤2 interactions:
//   • approve-once  → owner signs authorizeOnce(callHash, expiry), then decideCapability approve_once
//   • always-allow  → owner CONFIRMS a rule (built from the decoded target/selector + a cap),
//                     signs proposeCallRule, then decideCapability always_allow
//   • deny          → decideCapability deny, no tx
// The suggested rule is NEVER pre-approved silently — always-allow opens an explicit confirm.
'use client';

import { useState } from 'react';
import type { CallRule, CapabilityRequestRow, Hex } from '@/lib/types';
import { shortAddr } from '@/lib/format';
import { noveltyReason } from '@/lib/capabilities';
import { Disclosure } from '@/components/ui/Disclosure';

type Busy = 'once' | 'always' | 'deny' | null;

export function CapabilityDecisionCard({
  request,
  onApproveOnce,
  onAlwaysAllow,
  onDeny,
}: {
  request: CapabilityRequestRow;
  /** Owner signs authorizeOnce(callHash, expiry) then records the decision. */
  onApproveOnce: (callHash: Hex) => Promise<void>;
  /** Owner signs proposeCallRule(rule) then records always_allow with that rule. */
  onAlwaysAllow: (rule: CallRule) => Promise<void>;
  /** No tx. */
  onDeny: () => Promise<void>;
}) {
  const d = request.decoded;
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // The owner confirms the standing cap before it becomes a rule (never auto-filled silently).
  const [perCallCap, setPerCallCap] = useState('');
  const [windowCapCall, setWindowCapCall] = useState('');

  const reasons = request.novelty.map(noveltyReason);

  async function run(kind: Exclude<Busy, null>, fn: () => Promise<void>) {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send your decision. Try again.');
    } finally {
      setBusy(null);
    }
  }

  function confirmAlwaysAllow() {
    // The owner-confirmed rule — built from the decoded call, with caps the owner just typed.
    const rule: CallRule = {
      target: d.target,
      selector: d.selector,
      recipientMode: 'self',
      spenderSet: [],
      perCallCap: perCallCap.trim() || d.value || '0',
      windowCapCall: windowCapCall.trim() || perCallCap.trim() || d.value || '0',
    };
    return run('always', () => onAlwaysAllow(rule));
  }

  return (
    <section
      aria-label="Agent needs a capability decision"
      className="raised"
      data-testid="capability-decision-card"
      style={{ padding: '1rem 1.1rem', display: 'grid', gap: '0.7rem', borderColor: 'rgba(198,242,77,0.45)' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <span className="pill pill-accent">Needs your decision</span>
        <span className="pill" style={{ fontSize: '0.7rem' }}>UNVERIFIED</span>
      </div>

      <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--color-ink-dim)' }}>
        Your agent paused to ask before doing something new. This is what it says it wants to do —
        we show it word-for-word but we can&apos;t vouch for it, so it&apos;s marked UNVERIFIED.
      </p>
      {/* Quarantined agent-authored text — PLAIN TEXT only, never markup. */}
      <p data-testid="jit-intent" style={{ margin: 0, fontSize: '0.95rem' }}>{d.humanReadable}</p>

      {reasons.length > 0 ? (
        <p style={{ margin: 0, fontSize: '0.86rem' }}>
          It had to ask because it involves {reasons.join(', ')}.
        </p>
      ) : null}

      <Disclosure label="Show the exact call">
        <dl style={{ margin: 0, display: 'grid', gap: '0.2rem' }}>
          <div>target: <span className="code">{d.target}</span></div>
          <div>selector: <span className="code">{d.selector}</span></div>
          {d.signature ? <div>signature: <span className="code">{d.signature}</span></div> : null}
          <div>call hash: <span className="code">{request.callHash}</span></div>
        </dl>
      </Disclosure>

      {error ? (
        <p role="alert" style={{ color: 'var(--color-deny)', fontSize: '0.84rem', margin: 0 }}>
          {error}
        </p>
      ) : null}

      {!confirming ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem' }}>
          <button
            type="button"
            className="btn btn-primary"
            data-testid="jit-approve-once"
            disabled={busy !== null}
            onClick={() => void run('once', () => onApproveOnce(request.callHash))}
          >
            {busy === 'once' ? 'Waiting for wallet…' : 'Allow once'}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            data-testid="jit-always-allow"
            disabled={busy !== null}
            onClick={() => setConfirming(true)}
          >
            Always allow this…
          </button>
          <button
            type="button"
            className="btn btn-danger"
            data-testid="jit-deny"
            disabled={busy !== null}
            onClick={() => void run('deny', onDeny)}
          >
            {busy === 'deny' ? 'Saying no…' : 'Deny'}
          </button>
        </div>
      ) : (
        <div
          role="group"
          aria-label="Confirm a standing permission"
          data-testid="jit-always-allow-panel"
          style={{ display: 'grid', gap: '0.6rem' }}
        >
          <p style={{ margin: 0, fontSize: '0.86rem' }}>
            This grants a <strong>standing permission</strong> to call {shortAddr(d.target)}. Set the
            limits it can spend per call and per window, then confirm. Because it loosens the leash,
            it waits a short safety delay on-chain before taking effect.
          </p>
          <label className="label" htmlFor={`cap-${request.id}`}>Per-call limit (base units)</label>
          <input
            id={`cap-${request.id}`}
            className="field"
            data-testid="jit-per-call"
            inputMode="numeric"
            value={perCallCap}
            onChange={(e) => setPerCallCap(e.target.value)}
            placeholder="e.g. 100000000"
            disabled={busy !== null}
          />
          <label className="label" htmlFor={`win-${request.id}`}>Window limit (base units)</label>
          <input
            id={`win-${request.id}`}
            className="field"
            data-testid="jit-window-cap"
            inputMode="numeric"
            value={windowCapCall}
            onChange={(e) => setWindowCapCall(e.target.value)}
            placeholder="e.g. 500000000"
            disabled={busy !== null}
          />
          <div style={{ display: 'flex', gap: '0.6rem' }}>
            <button
              type="button"
              className="btn btn-primary"
              data-testid="jit-always-allow-confirm"
              disabled={busy !== null}
              onClick={() => void confirmAlwaysAllow()}
            >
              {busy === 'always' ? 'Waiting for wallet…' : 'Confirm & sign'}
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
