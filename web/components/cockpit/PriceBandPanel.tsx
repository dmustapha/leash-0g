// File: web/components/cockpit/PriceBandPanel.tsx
// FR4 (F-9): the band-arm surface. A band-capable trader agent mints through the
// oracle-band factory, but the band itself is OWNER LAW: two owner-wallet txs —
// (1) tightenPriceBand pins router.swap to a live price feed for the held asset
// (INSTANT — a new band is a new restriction), (2) enableRequireBandForSwap latches
// "no swap without a healthy band check" (one-way, fail-closed). The armed pill
// reads the chain live; this panel never trusts a cached mirror.
// Never-guess-money: the feed address is OWNER-TYPED; the asset prefills from the
// owner-typed trader goal; the target is the chain's canonical router (config truth).
'use client';

import { useState } from 'react';
import { shortAddr } from '@/lib/format';
import { Field } from '@/components/ui/Field';

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export function PriceBandPanel({
  routerAddr,
  defaultAsset,
  armed,
  bandSet,
  onTighten,
  onEnable,
}: {
  /** The chain's canonical swap router (band target). */
  routerAddr: string;
  /** Prefill for the asset — the trader goal's hold token (owner-typed at create). */
  defaultAsset: string;
  /** Live requireBandForSwap() — fully armed once true. */
  armed: boolean;
  /** Whether step 1 signed in this session (UI sequencing only; chain stays authoritative). */
  bandSet: boolean;
  onTighten: (band: { feed: string; asset: string; maxDeviationBps: number; maxStalenessSec: number }) => Promise<void>;
  onEnable: () => Promise<void>;
}) {
  const [feed, setFeed] = useState('');
  const [asset, setAsset] = useState(defaultAsset);
  const [bps, setBps] = useState('500');
  const [staleness, setStaleness] = useState('3600');
  const [busy, setBusy] = useState<null | 'tighten' | 'enable'>(null);
  const [error, setError] = useState<string | null>(null);
  // Review fix (FR4 blocker): chain state (bandSet prop, read live by the parent) is the
  // source of truth across remounts; a tighten signed THIS session also unlocks step 2.
  const [tightenedNow, setTightenedNow] = useState(false);
  const step1Done = bandSet || tightenedNow;

  const run = async (which: 'tighten' | 'enable') => {
    setError(null);
    setBusy(which);
    try {
      if (which === 'tighten') {
        if (!ADDR_RE.test(feed)) throw new Error('Enter the price feed contract address (0x…).');
        if (!ADDR_RE.test(asset)) throw new Error('Enter the asset token address (0x…).');
        const dev = Number(bps);
        const stale = Number(staleness);
        if (!Number.isInteger(dev) || dev <= 0 || dev > 10_000) throw new Error('Max deviation must be 1–10000 bps.');
        if (!Number.isInteger(stale) || stale <= 0) throw new Error('Max feed age must be a positive number of seconds.');
        await onTighten({ feed, asset, maxDeviationBps: dev, maxStalenessSec: stale });
        setTightenedNow(true);
      } else {
        await onEnable();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The transaction was not signed.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-label="Price band wall" className="card" data-testid="price-band-panel" style={{ padding: '1rem 1.1rem', display: 'grid', gap: '0.75rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ fontSize: '1rem', margin: 0 }}>Price band wall</h2>
        <span className={armed ? 'pill pill-allow' : 'pill pill-idle'} data-testid="band-armed-pill">
          {armed ? 'armed — every swap is band-checked on-chain' : 'not armed yet'}
        </span>
      </div>
      {armed ? (
        <p style={{ color: 'var(--color-ink-dim)', fontSize: '0.88rem', margin: 0 }}>
          Trades through {shortAddr(routerAddr)} are refused by the contract when the pool price
          drifts more than the band from the oracle, or when the feed is stale. Tightening the
          band is instant; loosening waits out the safety delay.
        </p>
      ) : (
        <>
          <p style={{ color: 'var(--color-ink-dim)', fontSize: '0.88rem', margin: 0 }}>
            Two signatures arm the wall: pin a live price feed to every swap on{' '}
            {shortAddr(routerAddr)}, then latch “no swap without a healthy band check”. Both are
            enforced by the account contract — LEASH can never loosen them for you.
          </p>
          <Field
            id="band-feed"
            label="Price feed (oracle) address"
            hint="The on-chain feed the band checks against. You type it — nothing fills it in for you."
            value={feed}
            onChange={(e) => setFeed(e.target.value.trim())}
            placeholder="0x…"
            disabled={busy !== null}
          />
          <Field
            id="band-asset"
            label="Asset it prices"
            hint="Prefilled from this agent's hold target."
            value={asset}
            onChange={(e) => setAsset(e.target.value.trim())}
            placeholder="0x…"
            disabled={busy !== null}
          />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem' }}>
            <Field
              id="band-bps"
              label="Max deviation (bps)"
              hint="500 = 5% from the oracle price."
              value={bps}
              onChange={(e) => setBps(e.target.value.trim())}
              inputMode="numeric"
              disabled={busy !== null}
            />
            <Field
              id="band-staleness"
              label="Max feed age (seconds)"
              hint="Older feed = swap refused (fail-closed)."
              value={staleness}
              onChange={(e) => setStaleness(e.target.value.trim())}
              inputMode="numeric"
              disabled={busy !== null}
            />
          </div>
          {error !== null && <p role="alert" style={{ color: 'var(--color-danger, #e07a7a)', fontSize: '0.85rem', margin: 0 }}>{error}</p>}
          <div style={{ display: 'flex', gap: '0.6rem' }}>
            <button type="button" className="btn btn-primary" disabled={busy !== null || step1Done} onClick={() => void run('tighten')}>
              {busy === 'tighten' ? 'Waiting for wallet…' : step1Done ? '1. Band set ✓' : '1. Set the band'}
            </button>
            <button type="button" className="btn btn-primary" disabled={busy !== null || !step1Done} onClick={() => void run('enable')}>
              {busy === 'enable' ? 'Waiting for wallet…' : '2. Require band for every swap'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
