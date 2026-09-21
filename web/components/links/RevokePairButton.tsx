// File: web/components/links/RevokePairButton.tsx
// REVOKE PAIR (spec §3c): one action → POST /api/agents/revoke-batch with both agent ids.
// Per-agent results rendered honestly; any failure gets a prominent owner-wallet
// direct-revoke fallback CTA for that account (C-2 steer).
'use client';

import { useState } from 'react';
import type { Address } from 'viem';
import type { RevokeBatchResult } from '@/lib/types';

export function RevokePairButton({
  agentNames,
  onRevokeBatch,
  onWalletRevoke,
}: {
  /** agentId → display name for result rows. */
  agentNames: Record<string, string>;
  onRevokeBatch: () => Promise<RevokeBatchResult[]>;
  /** Owner-wallet direct revoke() on one account — the LEASH-independent escape hatch. */
  onWalletRevoke: (accountAddr: Address) => Promise<string>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [walletBusy, setWalletBusy] = useState<string | null>(null);
  const [results, setResults] = useState<RevokeBatchResult[] | null>(null);
  const [walletTxs, setWalletTxs] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const name = (id: string) => agentNames[id] ?? `${id.slice(0, 8)}…`;

  async function revokeBoth() {
    setBusy(true);
    setError(null);
    try {
      setResults(await onRevokeBatch());
      setConfirming(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Revoke failed. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function walletRevoke(agentId: string, accountAddr: Address) {
    setWalletBusy(agentId);
    setError(null);
    try {
      const tx = await onWalletRevoke(accountAddr);
      setWalletTxs((prev) => ({ ...prev, [agentId]: tx }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The wallet transaction failed.');
    } finally {
      setWalletBusy(null);
    }
  }

  return (
    <div className="panel" style={{ padding: '0.9rem 1rem', display: 'grid', gap: '0.7rem', borderColor: 'rgba(255,93,108,0.35)' }}>
      {!confirming ? (
        <button type="button" className="btn btn-danger" onClick={() => setConfirming(true)} data-testid="revoke-pair-btn">
          Revoke both agents
        </button>
      ) : (
        <div style={{ display: 'grid', gap: '0.6rem' }} role="alertdialog" aria-label="Confirm pair revoke">
          <p style={{ fontSize: '0.9rem' }}>
            Cut BOTH agents off now? They stop instantly, cannot spend another wei, and any
            unfinished handoffs between them are cancelled.
          </p>
          <div style={{ display: 'flex', gap: '0.6rem' }}>
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void revokeBoth()} data-testid="confirm-revoke-pair-btn">
              {busy ? 'Revoking…' : 'Yes, revoke both'}
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {results ? (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.55rem' }} data-testid="revoke-pair-results">
          {results.map((r) => {
            const fallback = r.ownerRevokeFallback;
            return (
            <li key={r.agentId} data-testid={`revoke-result-${r.agentId}`} style={{ display: 'grid', gap: '0.45rem' }}>
              <div style={{ display: 'flex', gap: '0.55rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '0.88rem', fontWeight: 600 }}>{name(r.agentId)}</span>
                {r.ok ? (
                  <span className="pill pill-deny">{r.alreadyRevoked ? 'already revoked' : 'revoked'}</span>
                ) : (
                  <span className="pill pill-deny">revoke FAILED</span>
                )}
                {r.txHash ? <span className="code">tx {r.txHash.slice(0, 14)}…</span> : null}
              </div>
              {!r.ok && fallback ? (
                <div className="raised" role="alert" data-testid={`revoke-fallback-${r.agentId}`} style={{ padding: '0.7rem 0.85rem', display: 'grid', gap: '0.5rem', borderColor: 'rgba(255,93,108,0.5)' }}>
                  <p style={{ fontSize: '0.86rem' }}>
                    LEASH could not revoke {name(r.agentId)} via its guardian. Revoke it directly
                    from your wallet — this works even if LEASH is down.
                  </p>
                  {walletTxs[r.agentId] ? (
                    <p className="code" data-testid={`wallet-revoke-tx-${r.agentId}`}>tx {walletTxs[r.agentId]}</p>
                  ) : (
                    <div>
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        disabled={walletBusy !== null}
                        onClick={() => void walletRevoke(r.agentId, fallback.accountAddr)}
                        data-testid={`wallet-revoke-${r.agentId}`}
                      >
                        {walletBusy === r.agentId ? 'Waiting for wallet…' : 'Revoke with my wallet'}
                      </button>
                    </div>
                  )}
                </div>
              ) : null}
            </li>
            );
          })}
        </ul>
      ) : null}

      {error ? (
        <p role="alert" style={{ color: 'var(--color-deny)', fontSize: '0.84rem' }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
