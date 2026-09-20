// File: web/components/cockpit/PolicyPanel.tsx
// Policy view + owner edits. Tightening (lower caps) applies instantly via tightenPolicy;
// loosening goes through proposePolicy and shows a pending-change card with a live countdown
// until applyPolicy/applyAllowlist/applyWithdraw can fire. All are wallet txs signed
// client-side.
'use client';

import { useEffect, useMemo, useState } from 'react';
import type { AgentDetail } from '@/lib/types';
import type { PendingEtas } from '@/lib/chain';
import { countdown, isValidOgAmount, ogToWei, weiToOg, shortAddr } from '@/lib/format';
import { Field } from '@/components/ui/Field';
import { Disclosure } from '@/components/ui/Disclosure';

export type PendingKind = keyof PendingEtas;

const PENDING_LABELS: Record<PendingKind, string> = {
  policy: 'limit raise',
  allowlist: 'new recipient',
  withdraw: 'withdrawal',
};

export function PolicyPanel({
  detail,
  onSubmitPolicy,
  pending,
  onApply,
}: {
  detail: AgentDetail;
  /** Called with the new policy; implementation picks tightenPolicy vs proposePolicy. */
  onSubmitPolicy: (p: { perTransferCapWei: string; windowCapWei: string }, loosening: boolean) => Promise<void>;
  /** Unix-seconds etas for the three timelock queues; 0 = nothing pending. */
  pending: PendingEtas;
  /** Fires the matching applyPolicy/applyAllowlist/applyWithdraw wallet tx. */
  onApply: (kind: PendingKind) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [perTransfer, setPerTransfer] = useState(weiToOg(detail.policy.perTransferCapWei));
  const [windowCap, setWindowCap] = useState(weiToOg(detail.policy.windowCapWei));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState<PendingKind | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);

  // 1s tick drives the live countdowns on pending-change cards.
  const anyPending = pending.policy > 0 || pending.allowlist > 0 || pending.withdraw > 0;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!anyPending) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyPending]);

  async function apply(kind: PendingKind) {
    setApplying(kind);
    setApplyError(null);
    try {
      await onApply(kind);
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : 'The wallet transaction failed.');
    } finally {
      setApplying(null);
    }
  }

  const loosening = useMemo(() => {
    if (!isValidOgAmount(perTransfer) || !isValidOgAmount(windowCap)) return false;
    return (
      BigInt(ogToWei(perTransfer)) > BigInt(detail.policy.perTransferCapWei) ||
      BigInt(ogToWei(windowCap)) > BigInt(detail.policy.windowCapWei)
    );
  }, [perTransfer, windowCap, detail.policy]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValidOgAmount(perTransfer) || !isValidOgAmount(windowCap)) {
      setError('Enter amounts greater than zero, like 0.01.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmitPolicy(
        { perTransferCapWei: ogToWei(perTransfer), windowCapWei: ogToWei(windowCap) },
        loosening,
      );
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The wallet transaction failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Agent limits" className="card" style={{ padding: '1rem 1.1rem', display: 'grid', gap: '0.8rem' }}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <h2 style={{ fontSize: '1rem' }}>Limits</h2>
        <span style={{ flex: 1 }} />
        {!editing ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>
            Change limits
          </button>
        ) : null}
      </div>

      {!editing ? (
        <dl style={{ display: 'grid', gap: '0.5rem', margin: 0, fontSize: '0.88rem' }}>
          <Row k="Per payment" v={`${weiToOg(detail.policy.perTransferCapWei)} 0G max`} />
          <Row
            k="Budget"
            v={`${weiToOg(detail.policy.windowCapWei)} 0G / ${Math.round(detail.policy.windowSeconds / 3600)}h`}
          />
          <Row k="Can pay" v={detail.policy.allowlist.map(shortAddr).join(', ') || 'nobody yet'} />
          <Row k="Expires" v={new Date(detail.policy.expiresAt * 1000).toLocaleString()} />
        </dl>
      ) : (
        <form onSubmit={(e) => void submit(e)} style={{ display: 'grid', gap: '0.8rem' }}>
          <Field
            id="edit-per-transfer"
            label="Per payment max"
            value={perTransfer}
            onChange={(e) => setPerTransfer(e.target.value)}
            inputMode="decimal"
            suffix="0G"
          />
          <Field
            id="edit-window-cap"
            label={`Budget per ${Math.round(detail.policy.windowSeconds / 3600)}h`}
            value={windowCap}
            onChange={(e) => setWindowCap(e.target.value)}
            inputMode="decimal"
            suffix="0G"
            error={error}
          />
          {loosening ? (
            <p style={{ fontSize: '0.82rem', color: 'var(--color-accent)' }}>
              You are raising a limit. For safety this waits a short delay on-chain before it
              takes effect.
            </p>
          ) : null}
          <div style={{ display: 'flex', gap: '0.6rem' }}>
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
              {busy ? 'Waiting for wallet…' : loosening ? 'Propose change' : 'Apply now'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {(Object.keys(PENDING_LABELS) as PendingKind[])
        .filter((kind) => pending[kind] > 0)
        .map((kind) => {
          const eta = pending[kind];
          const ready = eta * 1000 <= now;
          return (
            <div
              key={kind}
              className="panel"
              data-testid={`pending-${kind}`}
              style={{ padding: '0.7rem 0.8rem', display: 'grid', gap: '0.5rem' }}
            >
              <p style={{ margin: 0, fontSize: '0.86rem' }}>
                <span className="badge" data-testid={`pending-${kind}-eta`} aria-live="polite">
                  {ready
                    ? `Your ${PENDING_LABELS[kind]} is ready to apply`
                    : `Your ${PENDING_LABELS[kind]} unlocks in ${countdown(eta, now)}`}
                </span>
              </p>
              <div>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={!ready || applying !== null}
                  onClick={() => void apply(kind)}
                  data-testid={`apply-${kind}`}
                >
                  {applying === kind ? 'Waiting for wallet…' : ready ? 'Apply now' : 'Waiting for the safety delay'}
                </button>
              </div>
            </div>
          );
        })}
      {applyError ? (
        <p role="alert" style={{ color: 'var(--color-deny)', fontSize: '0.84rem' }}>
          {applyError}
        </p>
      ) : null}

      <Disclosure label="Why do raises wait, but cuts apply instantly?">
        The on-chain account uses an asymmetric timelock: tightening (tightenPolicy) is instant so
        you can always clamp down fast; loosening (proposePolicy → applyPolicy) waits a delay so a
        compromised session can never quietly raise its own limits.
      </Disclosure>
    </section>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.8rem', borderBottom: '1px solid var(--color-line-soft)', paddingBottom: '0.4rem' }}>
      <dt className="label">{k}</dt>
      <dd style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: '0.84rem', textAlign: 'right' }}>{v}</dd>
    </div>
  );
}
