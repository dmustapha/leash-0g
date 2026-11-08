// File: web/components/cockpit/CapabilityEnvelope.tsx
// Read-only Stage-D envelope (D-14): what this agent can do on its own (standing grants +
// applied presets) and the recent one-off decisions you made. Plain-language surface; the
// address/selector jargon lives behind Disclosure. Quarantined agent-authored intent is
// rendered as PLAIN TEXT, labeled UNVERIFIED (never markup) — mirroring ApprovalCard.
'use client';

import { useState } from 'react';
import type { CapabilityEnvelopeView, CapabilityGrantRow, CapabilityRequestRow } from '@/lib/types';
import { shortAddr } from '@/lib/format';
import { noveltyReason, PRESET_CATALOG, recipientModeLabel } from '@/lib/capabilities';
import { Disclosure } from '@/components/ui/Disclosure';
import { formatAssetAmount } from '@/lib/asset';

const STATUS_COPY: Record<string, string> = {
  proposed: 'waiting for the safety delay',
  active: 'active',
  removed: 'removed',
  pending: 'still waiting on you',
  approved_once: 'you allowed it once',
  always_allowed: 'you allowed it from now on',
  denied: 'you said no',
  expired: 'expired before you decided',
};

function presetName(key: string): string {
  return PRESET_CATALOG.find((p) => p.key === key)?.name ?? key;
}

// The sensitivity LANE (tools.html L1/L2/forbidden) mapped from LEASH's real grant/decision
// status: a standing/always-allowed capability runs on its own (L1 silent); one that is still
// maturing, allowed-once, or currently asking pauses for the owner (L2 asked); a denied/blocked
// one is forbidden. Color + shape — not just text — carry the meaning.
const LANE: Record<string, { cls: 'l1' | 'l2' | 'forbidden'; label: string }> = {
  active: { cls: 'l1', label: 'L1 silent' },
  always_allowed: { cls: 'l1', label: 'L1 silent' },
  proposed: { cls: 'l2', label: 'L2 asked' },
  pending: { cls: 'l2', label: 'L2 asked' },
  approved_once: { cls: 'l2', label: 'L2 asked' },
  denied: { cls: 'forbidden', label: 'forbidden' },
  expired: { cls: 'forbidden', label: 'forbidden' },
  removed: { cls: 'forbidden', label: 'forbidden' },
};

function LaneChip({ status }: { status: string }) {
  // Fail CLOSED: an unrecognized status (e.g. a future backend state, the way JobStatus grew
  // `settling`) must never silently render as "L1 silent / runs on its own" — that would
  // under-represent risk on the one surface that shows what the agent can do unattended. Default
  // an unknown state to the needs-your-attention lane, not the safe-looking one.
  const lane = LANE[status] ?? { cls: 'l2' as const, label: 'needs review' };
  return <span className={`lane-chip ${lane.cls}`}>{lane.label}</span>;
}

export function CapabilityEnvelope({
  envelope,
  onApplyGrant,
}: {
  envelope: CapabilityEnvelopeView;
  /** FR3 (F-8c): owner signs applyCallRule for a matured proposed rule, then the
   *  read-model flips it active. Absent ⇒ read-only (legacy surfaces/tests). */
  onApplyGrant?: (grant: CapabilityGrantRow) => Promise<void>;
}) {
  const { grants, presets, recentRequests } = envelope;
  const labels = envelope.labels ?? {};
  const activeGrants = grants.filter((g) => g.status !== 'removed');
  const isEmpty = activeGrants.length === 0 && presets.length === 0;

  return (
    <section
      aria-label="What this agent can do"
      className="card"
      data-testid="capability-envelope"
      style={{ padding: '1rem 1.1rem', display: 'grid', gap: '0.9rem' }}
    >
      <h2 style={{ fontSize: '1rem', margin: 0 }}>What this agent can do on its own</h2>

      {isEmpty ? (
        <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--ink-dim)' }}>
          This agent can&apos;t make any custom contract calls yet. Grant it a preset or a custom
          rule above, and it will still ask you before anything unusual.
        </p>
      ) : (
        <>
          {presets.length > 0 ? (
            <div style={{ display: 'grid', gap: '0.4rem' }}>
              <h3 className="label" style={{ margin: 0 }}>Applied presets</h3>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                {presets.map((p) => (
                  <span key={p.presetKey} className="pill" data-testid={`preset-applied-${p.presetKey}`}>
                    {presetName(p.presetKey)}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {activeGrants.length > 0 ? (
            <div style={{ display: 'grid', gap: '0.5rem' }}>
              <h3 className="label" style={{ margin: 0 }}>Standing permissions</h3>
              {/* tools.html .tool-list of .tool rows — one per real grant, lane-chip = its lane. */}
              <div className="tool-list">
                {activeGrants.map((g) => <GrantRow key={g.id} grant={g} labels={labels} {...(onApplyGrant ? { onApply: onApplyGrant } : {})} />)}
              </div>
            </div>
          ) : null}
        </>
      )}

      <div style={{ display: 'grid', gap: '0.5rem' }}>
        <h3 className="label" style={{ margin: 0 }}>Recent one-off decisions</h3>
        {recentRequests.length === 0 ? (
          <p style={{ margin: 0, fontSize: '0.86rem', color: 'var(--ink-dim)' }}>
            Nothing yet. When the agent tries something outside its permissions, it asks you here.
          </p>
        ) : (
          <div className="tool-list">
            {recentRequests.map((r) => <RecentRow key={r.id} request={r} />)}
          </div>
        )}
      </div>

      {/* Sensitive actions always re-ask, regardless of standing grants (tools.html .always-note). */}
      <div className="always-note">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <path d="M8 1.5 2 4v3.5c0 3.4 2.4 6 6 7 3.6-1 6-3.6 6-7V4L8 1.5Z" />
          <path d="M8 6v3" strokeLinecap="round" />
          <circle cx="8" cy="11" r=".6" fill="currentColor" stroke="none" />
        </svg>
        A sensitive call outside these permissions always pauses for your approval — it can never be blanket-allowed.
      </div>
    </section>
  );
}

type Labels = NonNullable<CapabilityEnvelopeView['labels']>;

function GrantRow({ grant, onApply, labels }: { grant: CapabilityGrantRow; onApply?: (g: CapabilityGrantRow) => Promise<void>; labels: Labels }) {
  const nameOf = (a: string): string => labels[a.toLowerCase()]?.name ?? shortAddr(a);
  // A rule on an ERC-20 limits amounts of THAT token: say them in its unit. Anything else stays raw.
  const tok = labels[grant.target.toLowerCase()];
  const cap = (v: string): string => (tok?.decimals != null ? formatAssetAmount(v, tok.decimals, tok.symbol) : v);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function apply() {
    if (!onApply) return;
    setBusy(true);
    setError(null);
    try {
      await onApply(grant);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The wallet transaction failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tool" data-testid={`grant-${grant.id}`}>
      <div className="trow1">
        <span className="tid" title={grant.target}>{nameOf(grant.target)}</span>
        <LaneChip status={grant.status} />
        <span className="tgrow" />
        <span className="badge">{STATUS_COPY[grant.status] ?? grant.status}</span>
      </div>
      <div className="tdesc">
        Can call {tok?.name ?? 'this contract'} — paying {recipientModeLabel(grant.recipientMode)}, up to {cap(grant.perCallCap)} per call.
      </div>
      <Disclosure label="Show the exact rule">
        <dl style={{ margin: 0, display: 'grid', gap: '0.2rem' }}>
          <div>target: <span className="code">{grant.target}</span></div>
          <div>selector: <span className="code">{grant.selector}</span></div>
          <div>per-call cap: <span className="code">{cap(grant.perCallCap)}</span></div>
          <div>window cap: <span className="code">{cap(grant.windowCapCall)}</span></div>
          {grant.spenderSet.length > 0 ? (
            <div>spenders: <span className="code">{grant.spenderSet.map(nameOf).join(', ')}</span></div>
          ) : null}
          <div>source: {grant.source}</div>
        </dl>
      </Disclosure>
      {grant.status === 'proposed' && onApply ? (
        // FR3 (F-8c): a proposed rule matures after the on-chain safety delay —
        // this is the missing affordance that finishes the custom-rule flow.
        // Applying before the delay passes is simply refused by the contract.
        <div style={{ display: 'grid', gap: '0.3rem', marginTop: '0.5rem' }}>
          {error ? <p role="alert" style={{ color: 'var(--deny)', fontSize: '0.8rem', margin: 0 }}>{error}</p> : null}
          <div>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              data-testid={`grant-apply-${grant.id}`}
              disabled={busy}
              onClick={() => void apply()}
            >
              {busy ? 'Waiting for wallet…' : 'Apply now (after the safety delay)'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function RecentRow({ request }: { request: CapabilityRequestRow }) {
  const reasons = request.novelty.map(noveltyReason);
  return (
    <div className="tool" data-testid={`recent-${request.id}`}>
      <div className="trow1">
        <span className="pill" style={{ fontSize: '0.7rem' }}>UNVERIFIED</span>
        <LaneChip status={request.status} />
        <span className="tgrow" />
        <span className="badge">{STATUS_COPY[request.status] ?? request.status}</span>
      </div>
      {/* Quarantined agent-authored text — PLAIN TEXT only, never markup. */}
      <p className="tdesc" style={{ color: 'var(--ink-dim)', fontSize: '0.86rem' }}>{request.decoded.humanReadable}</p>
      {reasons.length > 0 ? (
        <p style={{ margin: '0.25rem 0 0', fontSize: '0.8rem', color: 'var(--ink-faint)' }}>
          It wanted {reasons.join(', ')}.
        </p>
      ) : null}
    </div>
  );
}
