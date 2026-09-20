// File: web/components/cockpit/FundPanel.tsx
// Fund-the-agent surface, shared by the create done-screen and the cockpit low-balance
// warning. Pure and testable: sending + balance reads are injected; when onSend is absent
// (wallet not ready) the button explains instead of failing silently.
'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';
import { isValidOgAmount, ogToWei, weiToOg } from '@/lib/format';
import { txUrl } from '@/lib/chain';
import type { Hex } from '@/lib/types';
import { Field } from '@/components/ui/Field';

export function FundPanel({
  accountAddr,
  defaultAmountOg,
  onSend,
  getBalance,
  initialBalanceWei,
  onFunded,
  skipHref,
  idPrefix = 'fund',
}: {
  accountAddr: Address;
  /** Prefilled 0G amount, e.g. 2× the window cap. */
  defaultAmountOg: string;
  /** Plain native transfer from the owner wallet; resolves to the tx hash. */
  onSend?: (valueWei: bigint) => Promise<Hex>;
  /** Live balance readback (polled). Omit when no chain is reachable (tests/E2E). */
  getBalance?: () => Promise<bigint>;
  initialBalanceWei?: string;
  onFunded?: () => void;
  /** When set, shows a "fund later" skip link (create flow). */
  skipHref?: string;
  idPrefix?: string;
}) {
  const [amount, setAmount] = useState(defaultAmountOg);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tx, setTx] = useState<Hex | null>(null);
  const [balanceWei, setBalanceWei] = useState<bigint | null>(
    initialBalanceWei !== undefined ? BigInt(initialBalanceWei) : null,
  );

  // Live balance readback: poll every 5s, keep the last good value on errors.
  useEffect(() => {
    if (!getBalance) return;
    let alive = true;
    const read = async () => {
      try {
        const b = await getBalance();
        if (alive) setBalanceWei(b);
      } catch {
        /* transient RPC hiccup — keep the last known balance */
      }
    };
    void read();
    const t = setInterval(() => void read(), 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [getBalance]);

  const send = useCallback(async () => {
    if (!onSend) {
      setError('Connect your wallet to send funds.');
      return;
    }
    if (!isValidOgAmount(amount)) {
      setError('Enter an amount greater than zero, like 0.1.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const hash = await onSend(BigInt(ogToWei(amount)));
      setTx(hash);
      onFunded?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The wallet transaction failed.');
    } finally {
      setBusy(false);
    }
  }, [onSend, amount, onFunded]);

  return (
    <div style={{ display: 'grid', gap: '0.7rem' }} data-testid={`${idPrefix}-section`}>
      <p style={{ fontSize: '0.82rem', color: 'var(--color-ink-dim)', fontFamily: 'var(--font-mono)', wordBreak: 'break-all', margin: 0 }}>
        To: {accountAddr}
      </p>
      <Field
        id={`${idPrefix}-amount`}
        label="Amount to send"
        hint="Roughly two budget windows is a comfortable start. You can always add more."
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        inputMode="decimal"
        suffix="0G"
        error={error}
      />
      <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={busy}
          onClick={() => void send()}
          data-testid={`${idPrefix}-send`}
        >
          {busy ? 'Waiting for wallet…' : 'Send from wallet'}
        </button>
        {balanceWei !== null ? (
          <span className="badge" data-testid={`${idPrefix}-balance`} aria-live="polite">
            account holds {weiToOg(balanceWei)} 0G
          </span>
        ) : null}
      </div>
      {tx ? (
        <p role="status" style={{ fontSize: '0.82rem', color: 'var(--color-ink-dim)', margin: 0 }}>
          Sent.{' '}
          <a href={txUrl(tx)} target="_blank" rel="noreferrer" className="nav-link">
            View the transaction →
          </a>
        </p>
      ) : null}
      {skipHref ? (
        <a href={skipHref} data-testid={`${idPrefix}-skip`} style={{ fontSize: '0.82rem', color: 'var(--color-ink-dim)' }}>
          Skip for now — you can fund later from the cockpit
        </a>
      ) : null}
    </div>
  );
}
