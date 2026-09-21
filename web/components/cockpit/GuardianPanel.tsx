// File: web/components/cockpit/GuardianPanel.tsx
// setGuardian surface (Gate-② parity, spec §3c): view the current guardian, replace it, or
// remove it entirely (setGuardian(0) — the escape hatch). All owner-wallet txs, signed
// client-side; the backend never holds owner authority.
'use client';

import { useState } from 'react';
import { isAddress, type Address } from 'viem';
import { ZERO_ADDRESS } from '@/lib/chain';
import { shortAddr } from '@/lib/format';
import { Disclosure } from '@/components/ui/Disclosure';
import { Field } from '@/components/ui/Field';

export function GuardianPanel({
  guardian,
  onSetGuardian,
}: {
  /** Current on-chain guardian; ZERO_ADDRESS = none; undefined = still loading/unavailable. */
  guardian: Address | undefined;
  /** Owner-wallet setGuardian tx; returns the tx hash. */
  onSetGuardian: (newGuardian: Address) => Promise<string>;
}) {
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [addr, setAddr] = useState('');
  const [busy, setBusy] = useState(false);
  const [tx, setTx] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hasGuardian = guardian !== undefined && guardian !== ZERO_ADDRESS;

  async function run(newGuardian: Address) {
    setBusy(true);
    setError(null);
    try {
      setTx(await onSetGuardian(newGuardian));
      setEditing(false);
      setRemoving(false);
      setAddr('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The wallet transaction failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Guardian" className="card" data-testid="guardian-panel" style={{ padding: '1rem 1.1rem', display: 'grid', gap: '0.7rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <h2 style={{ fontSize: '1rem' }}>Guardian</h2>
        <span style={{ flex: 1 }} />
        {guardian === undefined ? (
          <span className="pill pill-idle" data-testid="guardian-loading">checking…</span>
        ) : hasGuardian ? (
          <span className="badge" data-testid="guardian-addr" title={guardian}>
            {shortAddr(guardian)}
          </span>
        ) : (
          <span className="pill pill-idle" data-testid="guardian-none">none</span>
        )}
      </div>
      <p style={{ fontSize: '0.85rem', color: 'var(--color-ink-dim)' }}>
        The guardian is an emergency brake LEASH holds for you: it can ONLY cut this agent off,
        never spend or change anything. Your wallet can always revoke directly, guardian or not.
      </p>

      {!editing && !removing ? (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(true)} data-testid="guardian-edit-btn">
            {hasGuardian ? 'Replace guardian' : 'Set guardian'}
          </button>
          {hasGuardian ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRemoving(true)} data-testid="guardian-remove-btn">
              Remove guardian
            </button>
          ) : null}
        </div>
      ) : null}

      {editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!isAddress(addr)) {
              setError('Enter a valid wallet address (starts with 0x, 42 characters).');
              return;
            }
            void run(addr as Address);
          }}
          style={{ display: 'grid', gap: '0.7rem' }}
          data-testid="guardian-edit-form"
        >
          <Field
            id="guardian-address"
            label="New guardian address"
            hint="This address will be able to revoke the agent instantly — and do nothing else."
            value={addr}
            onChange={(e) => setAddr(e.target.value)}
            placeholder="0x…"
            error={error}
          />
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy} data-testid="guardian-save-btn">
              {busy ? 'Waiting for wallet…' : 'Set guardian'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setEditing(false); setError(null); }}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {removing ? (
        <div style={{ display: 'grid', gap: '0.6rem' }} role="alertdialog" aria-label="Confirm guardian removal" data-testid="guardian-remove-confirm">
          <p style={{ fontSize: '0.88rem' }}>
            Remove the guardian? This is the escape hatch: after this, ONLY your wallet can
            revoke this agent — LEASH cannot cut it off for you anymore.
          </p>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => void run(ZERO_ADDRESS)} data-testid="guardian-remove-confirm-btn">
              {busy ? 'Waiting for wallet…' : 'Yes, remove it'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setRemoving(false); setError(null); }}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {tx ? (
        <p className="code" role="status" data-testid="guardian-tx">tx {tx}</p>
      ) : null}
      {error && !editing ? (
        <p role="alert" style={{ color: 'var(--color-deny)', fontSize: '0.84rem' }}>
          {error}
        </p>
      ) : null}

      <Disclosure label="What exactly can a guardian do?">
        On the agent&apos;s on-chain account, the guardian address may call revoke() and nothing
        else — no spending, no policy changes, no withdrawals. LEASH uses a dedicated
        revoke-only key as the default guardian so it can pull the leash instantly when you ask.
        Replacing it points that power at an address you choose; removing it (setGuardian to the
        zero address) leaves your wallet as the only kill switch.
      </Disclosure>
    </section>
  );
}
