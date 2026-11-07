// File: web/components/cockpit/StatusBar.tsx
// Status strip: running/paused/revoked, session-expiry countdown, account balance.
'use client';

import { useEffect, useState } from 'react';
import type { AgentDetail } from '@/lib/types';
import { countdown, weiToOg, shortAddr } from '@/lib/format';
import { formatAssetAmount } from '@/lib/asset';

// G-2.5: console.html cockpit-head status spill (running/paused/revoked).
const STATUS_SPILL: Record<AgentDetail['status'], string> = {
  running: 'running',
  paused: 'paused',
  revoked: 'revoked',
};

export function StatusBar({
  detail,
  chainVerified,
  currency = '0G',
}: {
  detail: AgentDetail;
  /** GET /traces chainVerified flag — LEASH's own integrity check of the trace chain. */
  chainVerified?: boolean;
  /** Native symbol of the agent's HOME chain (SE-7) — RH/Base/Eth/Arb agents gas in ETH. */
  currency?: string;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // G-2.5: the console.html .cockpit-head — agent identity (name + account addr) on the left,
  // the real status/session/balance pills on the right. Reconciled to real data (no ENS).
  return (
    <section aria-label="Agent status" className="cockpit-head">
      <div className="who">
        <div className="name">{detail.agent?.name ?? 'Agent'}</div>
        <div className="addr">{shortAddr(detail.addresses.account)}</div>
      </div>
      <div className="statusbar">
        <span className={`spill ${STATUS_SPILL[detail.status]}`} data-testid="status-pill">
          {detail.status}
        </span>
        <span className="badge-pill" data-testid="session-countdown">
          session {countdown(detail.sessionExpiry, now)}
        </span>
        {detail.goalAsset ? (
          <>
            <span className="badge-pill" data-testid="asset-balance">
              {formatAssetAmount(detail.goalAsset.balanceWei, detail.goalAsset.decimals, detail.goalAsset.symbol)} in account
            </span>
            <span className="badge-pill" data-testid="gas-balance" title="Native coin the account holds for gas">
              gas {weiToOg(detail.accountBalance)} {currency}
            </span>
          </>
        ) : (
          <span className="badge-pill">{weiToOg(detail.accountBalance)} {currency} in account</span>
        )}
        {/* D-B9: inert freeform capability label — display only, no taxonomy/filter/discovery. */}
        {detail.agent?.capabilityLabel ? (
          <span className="badge-pill" data-testid="capability-label" title="What this agent is for">
            {detail.agent.capabilityLabel}
          </span>
        ) : null}
        {chainVerified === true ? (
          <span
            className="badge-pill jade"
            data-testid="server-verified-pill"
            title="LEASH's own integrity check of this trace chain — for independent verification use the Audit page"
          >
            ✓ server-verified
          </span>
        ) : chainVerified === false ? (
          <span
            className="chip chip-deny"
            data-testid="server-verify-failed-pill"
            title="LEASH's own integrity check of this trace chain FAILED — verify independently on the Audit page"
          >
            server check failed
          </span>
        ) : null}
      </div>
    </section>
  );
}
