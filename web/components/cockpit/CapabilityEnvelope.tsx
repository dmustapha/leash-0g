// File: web/components/cockpit/CapabilityEnvelope.tsx
// Read-only Stage-D envelope (D-14): what this agent can do on its own (standing grants +
// applied presets) and the recent one-off decisions you made. Plain-language surface; the
// address/selector jargon lives behind Disclosure. Quarantined agent-authored intent is
// rendered as PLAIN TEXT, labeled UNVERIFIED (never markup) — mirroring ApprovalCard.
'use client';

import type { CapabilityEnvelopeView, CapabilityGrantRow, CapabilityRequestRow } from '@/lib/types';
import { shortAddr } from '@/lib/format';
import { noveltyReason, PRESET_CATALOG, recipientModeLabel } from '@/lib/capabilities';
import { Disclosure } from '@/components/ui/Disclosure';

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

export function CapabilityEnvelope({ envelope }: { envelope: CapabilityEnvelopeView }) {
  const { grants, presets, recentRequests } = envelope;
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
        <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--color-ink-dim)' }}>
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
              {activeGrants.map((g) => <GrantRow key={g.id} grant={g} />)}
            </div>
          ) : null}
        </>
      )}

      <div style={{ display: 'grid', gap: '0.5rem' }}>
        <h3 className="label" style={{ margin: 0 }}>Recent one-off decisions</h3>
        {recentRequests.length === 0 ? (
          <p style={{ margin: 0, fontSize: '0.86rem', color: 'var(--color-ink-dim)' }}>
            Nothing yet. When the agent tries something outside its permissions, it asks you here.
          </p>
        ) : (
          recentRequests.map((r) => <RecentRow key={r.id} request={r} />)
        )}
      </div>
    </section>
  );
}

function GrantRow({ grant }: { grant: CapabilityGrantRow }) {
  return (
    <div
      className="panel"
      data-testid={`grant-${grant.id}`}
      style={{ padding: '0.6rem 0.75rem', display: 'grid', gap: '0.35rem' }}
    >
      <p style={{ margin: 0, fontSize: '0.88rem' }}>
        Can call {shortAddr(grant.target)} — paying {recipientModeLabel(grant.recipientMode)}.
        <span className="badge" style={{ marginLeft: '0.5rem' }}>{STATUS_COPY[grant.status] ?? grant.status}</span>
      </p>
      <Disclosure label="Show the exact rule">
        <dl style={{ margin: 0, display: 'grid', gap: '0.2rem' }}>
          <div>target: <span className="code">{grant.target}</span></div>
          <div>selector: <span className="code">{grant.selector}</span></div>
          <div>per-call cap: <span className="code">{grant.perCallCap}</span></div>
          <div>window cap: <span className="code">{grant.windowCapCall}</span></div>
          {grant.spenderSet.length > 0 ? (
            <div>spenders: <span className="code">{grant.spenderSet.map(shortAddr).join(', ')}</span></div>
          ) : null}
          <div>source: {grant.source}</div>
        </dl>
      </Disclosure>
    </div>
  );
}

function RecentRow({ request }: { request: CapabilityRequestRow }) {
  const reasons = request.novelty.map(noveltyReason);
  return (
    <div
      className="panel"
      data-testid={`recent-${request.id}`}
      style={{ padding: '0.6rem 0.75rem', display: 'grid', gap: '0.35rem' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <span className="pill" style={{ fontSize: '0.7rem' }}>UNVERIFIED</span>
        <span className="badge">{STATUS_COPY[request.status] ?? request.status}</span>
      </div>
      {/* Quarantined agent-authored text — PLAIN TEXT only, never markup. */}
      <p style={{ margin: 0, fontSize: '0.86rem' }}>{request.decoded.humanReadable}</p>
      {reasons.length > 0 ? (
        <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--color-ink-dim)' }}>
          It wanted {reasons.join(', ')}.
        </p>
      ) : null}
    </div>
  );
}
