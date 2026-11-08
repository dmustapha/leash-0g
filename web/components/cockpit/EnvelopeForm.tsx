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
import { AmountField } from '@/components/ui/AmountField';
import { formatAssetAmount, type AssetUnit } from '@/lib/asset';

type Phase = 'propose' | 'apply';
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export type EnvelopeFields = { asset: string; maxPerTransferCap: string; maxWindowCap: string; minWindowSeconds: number };
export type EnvelopeCurrent = { set: boolean; maxPerTransferCap: bigint; maxWindowCap: bigint; minWindowSeconds: number };
export type VetoFields = { vetoDelaySeconds: number; sharpBps: number };
export type VetoCurrent = { set: boolean; vetoDelaySeconds: number; sharpBps: number };

export function EnvelopeForm({
  onProposeEnvelope,
  onApplyEnvelope,
  onReadEnvelope,
  unitFor,
}: {
  /** decimals/symbol of the token the owner names, so the ceilings are typed and shown in that token. */
  unitFor?: (token: string) => AssetUnit | null;
  onProposeEnvelope: (f: EnvelopeFields) => Promise<void>;
  onApplyEnvelope: (f: EnvelopeFields) => Promise<void>;
  /** Live on-chain read for the entered asset (null when unset / not yet read). */
  onReadEnvelope: (asset: string) => Promise<EnvelopeCurrent | null>;
}) {
  const [asset, setAsset] = useState('');
  const envUnit = (): AssetUnit | null => unitFor?.(asset.trim()) ?? null;
  const envShow = (v: bigint): string => { const u = envUnit(); return u ? formatAssetAmount(v, u.decimals, u.symbol) : `${v.toString()} (smallest units)`; };
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

      <AmountField id="env-max-per" testId="env-max-per" label="Max per transfer" unit={unitFor?.(asset.trim()) ?? null} value={maxPer} onChange={setMaxPer} placeholder="10000000000000000000" disabled={busy || phase === 'apply'} />

      <AmountField id="env-max-window" testId="env-max-window" label="Max per window" unit={unitFor?.(asset.trim()) ?? null} value={maxWindow} onChange={setMaxWindow} placeholder="50000000000000000000" disabled={busy || phase === 'apply'} />

      <label className="label" htmlFor="env-min-window">Shortest window the agent may set (seconds)</label>
      <input id="env-min-window" className="field" data-testid="env-min-window" inputMode="numeric" value={minWindowSeconds} onChange={(e) => setMinWindowSeconds(e.target.value)} placeholder="86400" disabled={busy || phase === 'apply'} />

      {current?.set ? (
        <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--ink-dim)' }} data-testid="env-current">
          Live envelope for {shortAddr(asset.trim() as Address)}: ≤ {envShow(current.maxPerTransferCap)} per transfer,
          ≤ {envShow(current.maxWindowCap)} per window, window ≥ {current.minWindowSeconds}s.
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

// ── Veto config: the account-wide switch that turns on the instant (no-click) arm. The sharp
// threshold is a % of each envelope's window ceiling; a widening at or above it is held for the
// veto delay instead of landing instantly. First set is timelocked (a loosen) → propose then apply.
export function VetoConfigForm({
  onProposeVeto,
  onApplyVeto,
  onReadVeto,
}: {
  onProposeVeto: (f: VetoFields) => Promise<void>;
  onApplyVeto: (f: VetoFields) => Promise<void>;
  onReadVeto: () => Promise<VetoCurrent | null>;
}) {
  const [sharpPct, setSharpPct] = useState('50');
  const [vetoMinutes, setVetoMinutes] = useState('15');
  const [phase, setPhase] = useState<Phase>('propose');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<VetoCurrent | null>(null);

  function fields(): VetoFields {
    return { vetoDelaySeconds: Math.round(Number(vetoMinutes.trim()) * 60), sharpBps: Math.round(Number(sharpPct.trim()) * 100) };
  }
  function validate(): string | null {
    const p = Number(sharpPct.trim());
    const m = Number(vetoMinutes.trim());
    if (!(p >= 0 && p <= 100)) return 'Sharp threshold is a percent 0–100.';
    if (!(m > 0)) return 'Veto delay must be more than 0 minutes.';
    return null;
  }
  async function refresh() {
    try { setCurrent(await onReadVeto()); } catch { /* non-fatal convenience */ }
  }
  async function propose(e: React.FormEvent) {
    e.preventDefault();
    const v = validate();
    if (v) return setError(v);
    setBusy(true); setError(null);
    try { await onProposeVeto(fields()); setPhase('apply'); }
    catch (err) { setError(err instanceof Error ? err.message : 'The wallet transaction failed.'); }
    finally { setBusy(false); }
  }
  async function apply() {
    setBusy(true); setError(null);
    try { await onApplyVeto(fields()); setPhase('propose'); await refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : 'The wallet transaction failed.'); }
    finally { setBusy(false); }
  }

  return (
    <form onSubmit={(e) => void propose(e)} data-testid="veto-form" style={{ display: 'grid', gap: '0.6rem' }}>
      <h3 className="label" style={{ margin: 0 }}>Tune the veto (how bold a move it may make alone)</h3>
      <p style={{ margin: 0, fontSize: '0.84rem', color: 'var(--ink-dim)' }}>
        A change inside the envelope that stays under the sharp threshold lands instantly. A bolder
        widening is held for the veto delay so you can stop it. Until you set this, every move the
        agent makes on its own is held — nothing lands instantly.
      </p>

      <label className="label" htmlFor="veto-sharp">Sharp threshold (% of the envelope's window ceiling)</label>
      <input id="veto-sharp" className="field" data-testid="veto-sharp" inputMode="numeric" value={sharpPct} onChange={(e) => setSharpPct(e.target.value)} placeholder="50" disabled={busy || phase === 'apply'} />

      <label className="label" htmlFor="veto-delay">Veto delay (minutes)</label>
      <input id="veto-delay" className="field" data-testid="veto-delay" inputMode="numeric" value={vetoMinutes} onChange={(e) => setVetoMinutes(e.target.value)} placeholder="15" disabled={busy || phase === 'apply'} />

      {current?.set ? (
        <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--ink-dim)' }} data-testid="veto-current">
          Live: moves under {(current.sharpBps / 100).toString()}% of the window ceiling are instant; bolder ones wait {Math.round(current.vetoDelaySeconds / 60)} min for your veto.
        </p>
      ) : null}

      {error ? <p role="alert" style={{ color: 'var(--deny)', fontSize: '0.84rem', margin: 0 }}>{error}</p> : null}

      {phase === 'propose' ? (
        <div>
          <button type="submit" className="btn btn-primary btn-sm" data-testid="veto-propose" disabled={busy}>
            {busy ? 'Waiting for wallet…' : 'Propose veto settings'}
          </button>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '0.4rem' }}>
          <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--accent)' }}>Signed — takes effect in ~15 min. Come back and apply it.</p>
          <div>
            <button type="button" className="btn btn-primary btn-sm" data-testid="veto-apply" disabled={busy} onClick={() => void apply()}>
              {busy ? 'Waiting for wallet…' : 'Apply veto settings'}
            </button>
          </div>
        </div>
      )}
    </form>
  );
}
