// File: web/components/digest/DigestView.tsx
// STAGE G-2.2 — the daily digest, restyled to the owner-locked design (console.html
// data-view="digest": a 4-tile summary strip + a "Notable activity" panel + "Mark caught
// up"). The DESIGN is the artifact's; the DATA is the real digest (GET /api/digest). The
// artifact's four tiles are reconciled to real aggregates, and the artifact's flat
// notable-activity list is enriched to carry the real per-agent spend / balance-change /
// block counts the product actually tracks (money = spend + balance change only, no
// "earned" until the payments slice — 07 🟢 #11 honesty). Test ids preserved for the e2e.
'use client';

import { useMemo, useState } from 'react';
import type { AgentDigest, Digest } from '@/lib/types';
import { weiToOg } from '@/lib/format';

/** Signed 0G display for the balance-change delta; '—' until a baseline exists. */
function balanceChange(v: string | null): string {
  if (v === null) return '—';
  const n = BigInt(v);
  if (n === 0n) return '0 0G';
  return `${n > 0n ? '+' : ''}${weiToOg(n)} 0G`;
}

function AgentRow({ a }: { a: AgentDigest }) {
  const terminal = Object.entries(a.delegationsTerminal).filter(([, n]) => n > 0);
  const chipCls = a.status === 'revoked' ? 'chip-deny' : a.blocks > 0 ? 'chip-pend' : 'chip-allow';
  return (
    <div className="mini-row" data-testid={`digest-agent-${a.agentId}`}>
      <span className="lead">
        {a.name}{' '}
        <small>
          · {weiToOg(a.spendWei)} 0G spent · {a.actions} payment{a.actions === 1 ? '' : 's'} · {a.blocks} blocked ·{' '}
          {a.modifies} modified · balance change{' '}
          <span data-testid="balance-change" title={a.balanceChangeWei === null ? 'No baseline yet — appears after your first mark' : undefined}>
            {balanceChange(a.balanceChangeWei)}
          </span>
          {a.approvals.approved + a.approvals.denied + a.approvals.expired > 0
            ? ` · approvals: ${a.approvals.approved} approved, ${a.approvals.denied} denied, ${a.approvals.expired} expired`
            : ''}
          {terminal.length > 0 ? ` · handoffs ended: ${terminal.map(([s, n]) => `${n} ${s}`).join(', ')}` : ''}
        </small>
      </span>
      <span className={`chip ${chipCls}`}>{a.status === 'revoked' ? 'Revoked' : a.blocks > 0 ? 'Blocked' : 'Active'}</span>
    </div>
  );
}

export function DigestView({
  digest,
  onMark,
}: {
  digest: Digest;
  onMark: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tiles = useMemo(() => {
    const active = digest.agents.filter((a) => a.status !== 'revoked').length;
    // "Blocked today" = gateway policy blocks, SAME definition as the fleet summary tile
    // (app/page.tsx) so the number matches across both surfaces (Gate-②). Owner-rejected
    // approvals are a distinct thing, shown per-agent in the activity rows below.
    const blocked = digest.agents.reduce((s, a) => s + (a.blocks ?? 0), 0);
    return [
      { k: 'Settled today', v: `${weiToOg(digest.totals.spendWei)} 0G`, cls: 'allow' },
      { k: 'Blocked today', v: blocked, cls: blocked > 0 ? 'deny' : undefined },
      { k: 'Decisions handled', v: digest.totals.decisions, cls: 'accent' },
      { k: 'Agents active', v: `${active} / ${digest.agents.length}` },
    ];
  }, [digest]);

  return (
    <div>
      <div className="view-toolbar">
        <span className="section-title" style={{ margin: 0 }}>
          Daily digest ·{' '}
          <span className="n">
            {digest.since ? `since ${new Date(digest.since).toLocaleString()}` : 'everything so far'}
          </span>
        </span>
        <span className="grow" />
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
        <p role="alert" style={{ color: 'var(--deny)', fontSize: '0.85rem', margin: '0 0 var(--s-4)' }}>
          {error}
        </p>
      ) : null}

      {digest.empty ? (
        <div className="deadstate" data-testid="digest-empty">
          <svg className="leash-svg" viewBox="0 0 80 44" aria-hidden="true">
            <circle className="leash-clasp" cx="10" cy="22" r="6" />
            <path className="leash-path" d="M16 22 Q 40 30 74 22" />
          </svg>
          <h4>Nothing new</h4>
          <p>Nothing has happened since you last looked.</p>
        </div>
      ) : (
        <>
          <div className="digest-grid">
            {tiles.map((t) => (
              <div className="sum" key={t.k}>
                <div className="k">{t.k}</div>
                <div className={`v${t.cls ? ` ${t.cls}` : ''}`}>{t.v}</div>
              </div>
            ))}
          </div>

          <div className="panel" style={{ padding: 'var(--s-5)' }}>
            <p className="p-title">
              <span>Notable activity · since the last mark</span>
              <span className="badge-pill">
                {digest.totals.actions} payment{digest.totals.actions === 1 ? '' : 's'} · {digest.totals.decisions} decision
                {digest.totals.decisions === 1 ? '' : 's'}
              </span>
            </p>
            <div className="mini-list" data-testid="digest-agents">
              {digest.agents.map((a) => (
                <AgentRow key={a.agentId} a={a} />
              ))}
            </div>

            {digest.links.length > 0 ? (
              <div className="mini-list" style={{ marginTop: 'var(--s-4)' }} aria-label="Handoffs between agents">
                {digest.links.map((l) => (
                  <div className="mini-row" key={l.linkId} data-testid={`digest-link-${l.linkId}`}>
                    <span className="lead">
                      Handoff{' '}
                      <small>
                        ·{' '}
                        {Object.entries(l.byStatus)
                          .map(([s, n]) => `${n} ${s}`)
                          .join(', ')}
                      </small>
                    </span>
                  </div>
                ))}
              </div>
            ) : null}

            <p className="row-btns" style={{ marginTop: 'var(--s-4)', fontSize: '0.86rem', color: 'var(--ink-dim)' }} data-testid="digest-totals">
              <strong style={{ color: 'var(--ink)' }}>Total:</strong>&nbsp;{weiToOg(digest.totals.spendWei)} 0G spent ·{' '}
              {digest.totals.actions} payment{digest.totals.actions === 1 ? '' : 's'} · {digest.totals.decisions} decision
              {digest.totals.decisions === 1 ? '' : 's'} from you
            </p>
          </div>
        </>
      )}
    </div>
  );
}
