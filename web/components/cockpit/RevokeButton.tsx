// File: web/components/cockpit/RevokeButton.tsx
// The one-move kill switch. Always visible. Primary path = backend guardian revoke (instant, no
// wallet ceremony). Fallback behind a disclosure: revoke directly from the owner wallet on-chain,
// which works even if LEASH itself is down.
'use client';

import { useState } from 'react';

export function RevokeButton({
  onRevoke,
  onRevokeOnchain,
  onRearm,
  revoked,
}: {
  onRevoke: () => Promise<void>;
  onRevokeOnchain: () => Promise<string>; // returns tx hash
  /** Owner-wallet re-arm tx (rearm() on the on-chain account); returns tx hash. */
  onRearm?: () => Promise<string>;
  revoked: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [confirmingRearm, setConfirmingRearm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fallbackTx, setFallbackTx] = useState<string | null>(null);
  // C-2: the backend answered 502 guardian_revoke_failed — steer HARD to the wallet path.
  const [guardianFailed, setGuardianFailed] = useState(false);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      const out = await fn();
      if (typeof out === 'string') setFallbackTx(out);
      setConfirming(false);
      setGuardianFailed(false);
    } catch (e) {
      if ((e as { code?: string }).code === 'guardian_revoke_failed') {
        setGuardianFailed(true);
        setConfirming(false);
      } else {
        setError(e instanceof Error ? e.message : 'Revoke failed. Try the wallet fallback below.');
      }
    } finally {
      setBusy(false);
    }
  }

  if (revoked) {
    return (
      <div className="panel" style={{ padding: '0.9rem 1rem', display: 'grid', gap: '0.4rem' }}>
        <span className="pill pill-deny" data-testid="revoked-pill">
          Revoked
        </span>
        <p style={{ fontSize: '0.85rem', color: 'var(--color-ink-dim)' }}>
          This agent is cut off. It cannot pay anyone or use its brain until you re-arm it from
          your wallet.
        </p>
        {fallbackTx ? <p className="code">tx {fallbackTx}</p> : null}
        {onRearm ? (
          !confirmingRearm ? (
            <div>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setConfirmingRearm(true)}
                data-testid="rearm-btn"
              >
                Re-arm agent
              </button>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: '0.6rem' }} role="alertdialog" aria-label="Confirm re-arm">
              <p style={{ fontSize: '0.9rem' }}>
                Bring this agent back to life? Only the owner wallet can re-arm — your wallet will
                sign a rearm() transaction on the agent&apos;s on-chain account.
              </p>
              <div style={{ display: 'flex', gap: '0.6rem' }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const tx = await onRearm();
                      setConfirmingRearm(false);
                      return tx;
                    })
                  }
                  data-testid="confirm-rearm-btn"
                >
                  {busy ? 'Waiting for wallet…' : 'Yes, re-arm now'}
                </button>
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirmingRearm(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )
        ) : null}
        {error ? (
          <p role="alert" style={{ color: 'var(--color-deny)', fontSize: '0.84rem' }}>
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="panel" style={{ padding: '0.9rem 1rem', display: 'grid', gap: '0.6rem', borderColor: 'rgba(255,93,108,0.35)' }}>
      {!confirming ? (
        <button type="button" className="btn btn-danger" onClick={() => setConfirming(true)} data-testid="revoke-btn">
          Revoke agent
        </button>
      ) : (
        <div style={{ display: 'grid', gap: '0.6rem' }} role="alertdialog" aria-label="Confirm revoke">
          <p style={{ fontSize: '0.9rem' }}>
            Cut this agent off now? It stops instantly and cannot spend another wei.
          </p>
          <div style={{ display: 'flex', gap: '0.6rem' }}>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() => void run(onRevoke)}
              data-testid="confirm-revoke-btn"
            >
              {busy ? 'Revoking…' : 'Yes, revoke now'}
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {guardianFailed ? (
        <div className="raised" role="alert" data-testid="guardian-revoke-failed" style={{ padding: '0.8rem 0.9rem', display: 'grid', gap: '0.55rem', borderColor: 'rgba(255,93,108,0.5)' }}>
          <p style={{ fontSize: '0.88rem' }}>
            <strong>LEASH could not revoke via its guardian.</strong> Revoke directly from your
            wallet below — this works even if LEASH is down. The agent&apos;s runtime has been
            halted, but its on-chain account is NOT revoked yet.
          </p>
          <div>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={busy}
              onClick={() => void run(onRevokeOnchain)}
              data-testid="steer-revoke-onchain-btn"
            >
              {busy ? 'Waiting for wallet…' : 'Revoke on-chain with my wallet'}
            </button>
          </div>
          {fallbackTx ? <p className="code">tx {fallbackTx}</p> : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" style={{ color: 'var(--color-deny)', fontSize: '0.84rem' }}>
          {error}
        </p>
      ) : null}
      <details>
        <summary style={{ cursor: 'pointer', fontSize: '0.82rem', color: 'var(--color-ink-dim)' }}>
          Revoke directly from your wallet
        </summary>
        <div style={{ display: 'grid', gap: '0.5rem', paddingTop: '0.5rem' }}>
          <p style={{ fontSize: '0.82rem', color: 'var(--color-ink-dim)' }}>
            The escape hatch: your wallet calls revoke() on the agent&apos;s on-chain account
            itself. Works even if LEASH is completely down.
          </p>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={busy}
            onClick={() => void run(onRevokeOnchain)}
            data-testid="revoke-onchain-btn"
          >
            Revoke on-chain with my wallet
          </button>
        </div>
      </details>
    </div>
  );
}
