// File: web/components/digest/DigestView.tsx
// The daily glance (spec §3c): per-agent spend / balance / balance change + activity counts,
// per-link handoff outcomes, totals, and "Mark caught up". Money summary is spend + balance
// change ONLY — no "earned" until the payments slice (07 🟢 #11 honesty). Pure component.
'use client';

import { useState } from 'react';
import type { AgentDigest, Digest } from '@/lib/types';
import { weiToOg } from '@/lib/format';

/** Signed 0G display for the balance-change delta; '—' until a baseline exists. */
function balanceChange(v: string | null): string {
  if (v === null) return '—';
  const n = BigInt(v);
  if (n === 0n) return '0 0G';
  return `${n > 0n ? '+' : ''}${weiToOg(n)} 0G`;
}

function AgentCard({ a }: { a: AgentDigest }) {
  const terminal = Object.entries(a.delegationsTerminal).filter(([, n]) => n > 0);
  return (
    <article className="card" data-testid={`digest-agent-${a.agentId}`} style={{ padding: '1rem 1.1rem', display: 'grid', gap: '0.65rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <h3 style={{ fontSize: '0.98rem', margin: 0 }}>{a.name}</h3>
        <span className={`pill ${a.status === 'revoked' ? 'pill-deny' : 'pill-idle'}`}>{a.status}</span>
      </div>
      <dl style={{ display: 'grid', gap: '0.4rem', margin: 0, gridTemplateColumns: 'auto 1fr' }}>
        <dt className="label">Spent</dt>
        <dd style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: '0.86rem' }}>
          {weiToOg(a.spendWei)} 0G
        </dd>
        <dt className="label">Balance</dt>
        <dd style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: '0.86rem' }}>
          {weiToOg(a.balanceWei)} 0G
        </dd>
        <dt className="label">Balance change</dt>
        <dd
          style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: '0.86rem' }}
          data-testid="balance-change"
          title={a.balanceChangeWei === null ? 'No baseline yet — appears after your first mark' : undefined}
        >
          {balanceChange(a.balanceChangeWei)}
        </dd>
      </dl>
      <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--color-ink-dim)' }}>
        {a.actions} payment{a.actions === 1 ? '' : 's'} · {a.blocks} blocked · {a.modifies} modified
        {' · '}approvals: {a.approvals.approved} approved, {a.approvals.denied} denied,{' '}
        {a.approvals.expired} expired
      </p>
      {terminal.length > 0 ? (
        <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--color-ink-dim)' }}>
          handoffs ended: {terminal.map(([s, n]) => `${n} ${s}`).join(', ')}
        </p>
      ) : null}
    </article>
  );
}

export function DigestView({
  digest,
  onMark,
}: {
  digest: Digest;
  /** POST /api/digest/mark upstream; the page refreshes after. */
  onMark: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem', flexWrap: 'wrap' }}>
        <p style={{ margin: 0, fontSize: '0.86rem', color: 'var(--color-ink-dim)' }}>
          {digest.since
            ? `Since you last looked (${new Date(digest.since).toLocaleString()})`
            : 'Everything so far — you have not marked a digest yet'}
        </p>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={busy}
          data-testid="mark-caught-up-btn"
          onClick={() => {
            setBusy(true);
            setError(null);
            onMark()
              .catch((e) => setError(e instanceof Error ? e.message : 'Could not mark the digest.'))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? 'Marking…' : 'Mark caught up'}
        </button>
      </div>

      {error ? (
        <p role="alert" style={{ color: 'var(--color-deny)', fontSize: '0.85rem', margin: 0 }}>
          {error}
        </p>
      ) : null}

      {digest.empty ? (
        <p style={{ color: 'var(--color-ink-faint)', fontSize: '0.95rem' }} data-testid="digest-empty">
          Nothing new since you last looked.
        </p>
      ) : (
        <>
          <div
            style={{ display: 'grid', gap: '0.9rem', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))' }}
            data-testid="digest-agents"
          >
            {digest.agents.map((a) => (
              <AgentCard key={a.agentId} a={a} />
            ))}
          </div>

          {digest.links.length > 0 ? (
            <section aria-label="Handoffs between agents" className="card" style={{ padding: '1rem 1.1rem', display: 'grid', gap: '0.5rem' }}>
              <h3 style={{ fontSize: '0.98rem', margin: 0 }}>Handoffs between agents</h3>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.4rem' }}>
                {digest.links.map((l) => (
                  <li key={l.linkId} data-testid={`digest-link-${l.linkId}`} style={{ fontSize: '0.86rem', color: 'var(--color-ink-dim)' }}>
                    {Object.entries(l.byStatus)
                      .map(([s, n]) => `${n} ${s}`)
                      .join(', ')}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <p style={{ margin: 0, fontSize: '0.88rem' }} data-testid="digest-totals">
            <strong>Total:</strong> {weiToOg(digest.totals.spendWei)} 0G spent ·{' '}
            {digest.totals.actions} payment{digest.totals.actions === 1 ? '' : 's'} ·{' '}
            {digest.totals.decisions} decision{digest.totals.decisions === 1 ? '' : 's'} from you
          </p>
        </>
      )}
    </div>
  );
}
