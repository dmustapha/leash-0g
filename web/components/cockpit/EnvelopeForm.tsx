// File: web/components/cockpit/EnvelopeForm.tsx
// AQ-FND M-2 owner-envelope surface. The envelope is the CEILING the owner commits once per
// asset (max per-transfer, max window, min window-seconds); inside it the agent may enable and
// move that asset on its own (G-6 B arm), while a sharp widening is queued behind a veto (G-6 C).
// Loosen = propose (timelocked on the account's own delay) → apply the SAME payload after the eta;
// tighten = instant. Plain-language surface; base-unit numbers behind the Disclosure, like the
// spend-budget form.
'use client';

import { useState } from 'react';
import type { Address } from 'viem';
import { Disclosure } from '@/components/ui/Disclosure';
import { shortAddr } from '@/lib/format';

type Phase = 'propose' | 'apply';
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export type EnvelopeFields = { asset: string; maxPerTransferCap: string; maxWindowCap: string; minWindowSeconds: number };
export type EnvelopeCurrent = { set: boolean; maxPerTransferCap: bigint; maxWindowCap: bigint; minWindowSeconds: number };

export function EnvelopeForm({
  onProposeEnvelope,
  onApplyEnvelope,
  onReadEnvelope,
}: {
  onProposeEnvelope: (f: EnvelopeFields) => Promise<void>;
  onApplyEnvelope: (f: EnvelopeFields) => Promise<void>;
  /** Live on-chain read for the entered asset (null when unset / not yet read). */
  onReadEnvelope: (asset: string) => Promise<EnvelopeCurrent | null>;
}) {
  const [asset, setAsset] = useState('');
  const [maxPer, setMaxPer] = useState('');
  const [maxWindow, setMaxWindow] = useState('');
  const [minWindowSeconds, setMinWindowSeconds] = useState('86400');
  const [phase, setPhase] = useState<Phase>('propose');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<EnvelopeCurrent | null>(null);

  function fields(): EnvelopeFields {
    return { asset: asset.trim(), maxPerTransferCap: maxPer.trim(), maxWindowCap: maxWindow.trim(), minWindowSeconds: Number(minWindowSeconds.trim()) };
  }

  function validate(): string | null {
    if (!ADDR_RE.test(asset.trim())) return 'Enter a valid token address (0x…, 40 hex).';
    if (!/^\d+$/.test(maxPer.trim()) || !/^\d+$/.test(maxWindow.trim())) return 'Enter the caps as whole base-unit numbers.';
    if (!/^\d+$/.test(minWindowSeconds.trim()) || Number(minWindowSeconds.trim()) <= 0) return 'Enter a window length in seconds (> 0).';
    if (BigInt(maxWindow.trim()) < BigInt(maxPer.trim())) return 'The window ceiling must be ≥ the per-transfer ceiling.';
    return null;
  }

  async function refresh() {
    if (!ADDR_RE.test(asset.trim())) return;
    try {
      setCurrent(await onReadEnvelope(asset.trim()));
    } catch {
      /* non-fatal: the display is a convenience; the on-chain module stays authoritative */
    }
  }

  async function propose(e: React.FormEvent) {
    e.preventDefault();
    const v = validate();
    if (v) return setError(v);
    setBusy(true);
    setError(null);
    try {
      await onProposeEnvelope(fields());
      setPhase('apply');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The wallet transaction failed.');
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    setBusy(true);
    setError(null);
    try {
      await onApplyEnvelope(fields());
      setPhase('propose');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The wallet transaction failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void propose(e)} data-testid="envelope-form" style={{ display: 'grid', gap: '0.6rem' }}>
      <h3 className="label" style={{ margin: 0 }}>Set the agent's envelope for a token</h3>
      <p style={{ margin: 0, fontSize: '0.84rem', color: 'var(--ink-dim)' }}>
        The envelope is the ceiling you commit once. Inside it the agent can enable and move this
        token on its own, up to these limits — no click. A sharp widening is held for your veto.
      </p>

      <label className="label" htmlFor="env-asset">Token</label>
      <input id="env-asset" className="field" data-testid="env-asset" value={asset} onChange={(e) => setAsset(e.target.value)} onBlur={() => void refresh()} placeholder="0x…" disabled={busy || phase === 'apply'} />

      <label className="label" htmlFor="env-max-per">Max per transfer (base units)</label>
      <input id="env-max-per" className="field" data-testid="env-max-per" inputMode="numeric" value={maxPer} onChange={(e) => setMaxPer(e.target.value)} placeholder="10000000000000000000" disabled={busy || phase === 'apply'} />

      <label className="label" htmlFor="env-max-window">Max per window (base units)</label>
      <input id="env-max-window" className="field" data-testid="env-max-window" inputMode="numeric" value={maxWindow} onChange={(e) => setMaxWindow(e.target.value)} placeholder="50000000000000000000" disabled={busy || phase === 'apply'} />

      <label className="label" htmlFor="env-min-window">Shortest window the agent may set (seconds)</label>
      <input id="env-min-window" className="field" data-testid="env-min-window" inputMode="numeric" value={minWindowSeconds} onChange={(e) => setMinWindowSeconds(e.target.value)} placeholder="86400" disabled={busy || phase === 'apply'} />

      {current?.set ? (
        <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--ink-dim)' }} data-testid="env-current">
          Live envelope for {shortAddr(asset.trim() as Address)}: ≤ {current.maxPerTransferCap.toString()} per transfer,
          ≤ {current.maxWindowCap.toString()} per window, window ≥ {current.minWindowSeconds}s.
        </p>
      ) : null}

      <Disclosure label="What do these three numbers mean?">
        The agent may enable this token and set its own live limits, but never looser than the
        envelope: its per-transfer cap ≤ <strong>max per transfer</strong>, its window cap ≤
        <strong> max per window</strong>, and its window length ≥ <strong>shortest window</strong>
        (a longer window is tighter). Changes inside the envelope apply instantly; anything that
        reaches the sharp edge is queued for your veto.
      </Disclosure>

      {error ? <p role="alert" style={{ color: 'var(--deny)', fontSize: '0.84rem', margin: 0 }}>{error}</p> : null}

      {phase === 'propose' ? (
        <div>
          <button type="submit" className="btn btn-primary btn-sm" data-testid="env-propose" disabled={busy}>
            {busy ? 'Waiting for wallet…' : 'Propose envelope'}
          </button>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '0.4rem' }}>
          <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--accent)' }}>
            Signed — this takes effect in ~15 min. Come back and apply it.
          </p>
          <div>
            <button type="button" className="btn btn-primary btn-sm" data-testid="env-apply" disabled={busy} onClick={() => void apply()}>
              {busy ? 'Waiting for wallet…' : 'Apply envelope'}
            </button>
          </div>
        </div>
      )}
    </form>
  );
}
