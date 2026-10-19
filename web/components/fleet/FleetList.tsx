// File: web/components/fleet/FleetList.tsx
// STAGE G-2.2 — the FLEET, reskinned to the owner-locked design (console.html data-view
// "fleet": the `.agent` card grid with a leash-tension meter, status/role chips, and a
// three-fact row). This REPLACES the old flat list rows; the design is the artifact's,
// the data is the real product's.
//
// RECONCILED to what the fleet-list API actually gives (Dami-ruled "fleet-level facts"):
//   · the artifact's ENS name → dropped (no ENS); the card shows the real account address.
//   · the invented protocol chip (OpenAI/Anthropic/MCP) → the REAL runtime role chip
//     (treasury/sentinel/executor/…), from AgentSummary.role.
//   · `$` → 0G.
//   · the meter is spend-vs-balance HEADROOM (balance / (balance + spent-today)), from
//     listAgents + getDigest — NOT the artifact's daily-cap meter, because per-agent caps
//     live in AgentDetail, not the fleet list. Per-transfer cap + allowlist move to the
//     Cockpit (G-2.5), where detail is fetched.
//   · the three facts are real fleet-level numbers: Spent today / Blocked / Balance (from
//     the daily digest). The artifact's inline Edit/Cut buttons are omitted — those are
//     cockpit concerns (ruling 3: policies fold into the cockpit); the whole card opens it.
//
// Test IDs (fleet-list / fleet-row-* / fleet-empty / fleet-toggle-revoked / fleet-load-more
// / fleet-all-revoked) are preserved so the e2e fleet flows stay green.
'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { AgentSummary, AgentDigest } from '@/lib/types';
import { shortAddr, weiToOg } from '@/lib/format';

/** slack 0..1 → catenary path for the card meter (viewBox 0 0 520 56, midY 28, maxSag 18). */
function catenary(slack: number): string {
  const sag = (28 + Math.max(0, Math.min(1, slack)) * 18).toFixed(1);
  return `M8 28 Q 260 ${sag} 514 28`;
}

function AgentCard({ agent, digest }: { agent: AgentSummary; digest?: AgentDigest }) {
  const revoked = agent.status === 'revoked';
  const spentWei = digest?.spendWei ?? '0';
  const balanceWei = digest?.balanceWei ?? agent.accountBalanceWei;
  // headroom = balance proportion of (balance + spent-today). Full balance, nothing spent → 100%.
  // Computed in BigInt (wei), not Number(weiToOg()), so it stays exact at any balance — the
  // string→Number path would round away the 18 fractional digits above ~1e8 0G (Gate-②).
  const spentBig = BigInt(spentWei);
  const balBig = BigInt(balanceWei);
  const denomBig = spentBig + balBig;
  const headroom = revoked ? 0 : denomBig > 0n ? Number((balBig * 10000n) / denomBig) / 10000 : 1;
  const taut = !revoked && headroom < 0.18;
  const pct = Math.round(headroom * 100);
  const blocked = digest?.blocks ?? 0;

  const statusChip = revoked ? (
    <span className="chip chip-deny">Revoked</span>
  ) : taut ? (
    <span className="chip chip-pend">Low balance</span>
  ) : (
    <span className="chip chip-allow">Active</span>
  );

  return (
    <Link
      href={`/agents/${agent.agentId}`}
      className="agent"
      data-testid={`fleet-row-${agent.agentId}`}
      aria-label={`Open cockpit for ${agent.name}`}
    >
      <div className="row1">
        <div>
          <div className="name">{agent.name}</div>
          <div className="addr">{shortAddr(agent.accountAddr)}</div>
        </div>
        <div className="tags">
          {agent.role ? <span className="role-chip">{agent.role}</span> : null}
          {statusChip}
        </div>
      </div>

      <div className="meter">
        {revoked ? (
          <svg className="leash-svg cut" viewBox="0 0 520 56" preserveAspectRatio="none" aria-label="leash cut">
            <circle className="leash-clasp" cx="10" cy="28" r="6" />
            <path className="leash-path" d="M16 28 L 248 28" />
            <path className="leash-path" d="M272 28 L 510 28" />
            <path d="M252 17 l8 22 M268 17 l-8 22" stroke="var(--deny)" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        ) : (
          <svg
            className={`leash-svg${taut ? ' taut' : ''}`}
            viewBox="0 0 520 56"
            preserveAspectRatio="none"
            role="img"
            aria-label={`${pct}% balance headroom`}
          >
            <circle className="leash-clasp" cx="10" cy="28" r="6" />
            <path className="leash-path" d={catenary(headroom)} />
            <path className="leash-clasp" d="M514 28 a6 6 0 1 0 -0.1 0" strokeWidth="2" />
            <circle
              className="signal-pulse run"
              r="3.2"
              cx="0"
              cy="0"
              style={
                {
                  offsetPath: `path('${catenary(headroom)}')`,
                  WebkitOffsetPath: `path('${catenary(headroom)}')`,
                } as React.CSSProperties
              }
            />
          </svg>
        )}
        <div className="cap-label">
          {revoked ? (
            <span className="v-deny">leash cut</span>
          ) : (
            <>
              <span>
                headroom <b className={taut ? 'v-accent' : ''}>{pct}%</b>
              </span>
              <span>
                <b>{weiToOg(spentWei)}</b> 0G spent today
              </span>
            </>
          )}
        </div>
      </div>

      <div className="facts">
        <div className="fact">
          <div className="k">Spent today</div>
          <div className="v">{revoked ? <span className="faint">—</span> : `${weiToOg(spentWei)} 0G`}</div>
        </div>
        <div className="fact">
          <div className="k">Blocked</div>
          <div className={`v${blocked > 0 ? ' v-deny' : ''}`}>{revoked ? <span className="faint">—</span> : blocked}</div>
        </div>
        <div className="fact">
          <div className="k">Balance</div>
          <div className="v">{weiToOg(balanceWei)} 0G</div>
        </div>
      </div>
    </Link>
  );
}

export function FleetList({
  agents,
  digestByAgent,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  agents: AgentSummary[];
  digestByAgent?: Record<string, AgentDigest | undefined>;
  hasMore: boolean;
  loadingMore?: boolean;
  onLoadMore: () => void;
}) {
  const [showRevoked, setShowRevoked] = useState(false);
  const revokedCount = useMemo(() => agents.filter((a) => a.status === 'revoked').length, [agents]);
  const visible = showRevoked ? agents : agents.filter((a) => a.status !== 'revoked');

  if (agents.length === 0) {
    return (
      <div className="deadstate" data-testid="fleet-empty">
        <svg className="leash-svg" viewBox="0 0 80 44" aria-hidden="true">
          <circle className="leash-clasp" cx="10" cy="22" r="6" />
          <path className="leash-path" d="M16 22 Q 40 30 74 22" />
        </svg>
        <h4>No agents yet</h4>
        <p>Create your first one — it takes about a minute.</p>
        <Link href="/create" className="btn btn-primary">
          Create your agent
        </Link>
      </div>
    );
  }

  return (
    <div data-testid="fleet-list">
      {revokedCount > 0 ? (
        <div className="fleet-head">
          <span className="grow" />
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setShowRevoked((s) => !s)}
            data-testid="fleet-toggle-revoked"
            aria-pressed={showRevoked}
          >
            {showRevoked ? 'Hide revoked' : `Show revoked (${revokedCount})`}
          </button>
        </div>
      ) : null}
      {visible.length === 0 && revokedCount > 0 ? (
        <p data-testid="fleet-all-revoked" style={{ color: 'var(--ink-dim)' }}>
          All agents are revoked. Use the toggle above to view them.
        </p>
      ) : null}
      <div className="fleet">
        {visible.map((a) => (
          <AgentCard key={a.agentId} agent={a} digest={digestByAgent?.[a.agentId]} />
        ))}
      </div>
      {hasMore ? (
        <div style={{ marginTop: 'var(--s-4)' }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onLoadMore}
            disabled={loadingMore}
            data-testid="fleet-load-more"
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
