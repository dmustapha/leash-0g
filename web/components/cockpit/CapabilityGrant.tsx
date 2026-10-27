// File: web/components/cockpit/CapabilityGrant.tsx
// Stage-D owner granting surface. Two ways to grant a capability:
//
//  1. PRESET PICKER (D-9): pick one of six plain-language presets → resolvePreset previews its
//     rules → grant them rule-by-rule. IMPORTANT: the on-chain account has a SINGLE pending-rule
//     slot, and a loosen (proposeCallRule) is timelocked. So a multi-rule preset is applied
//     sequentially — for each rule: sign proposeCallRule → wait ~15 min → sign applyCallRule.
//     We make the sequence legible ("Step 2 of 3") and never claim an instant multi-grant. After
//     each sign we record the read-model.
//
//  2. CUSTOM RULE FORM: target + selector + caps + recipient mode + spenders. Loosen = propose
//     (timelocked); tighten/remove = instant. Plain-language surface; addresses/selectors behind
//     Disclosure.
'use client';

import { useState } from 'react';
import type { CallRule, CapabilityRuleAction, PresetKey, RecipientMode, ResolvedPreset } from '@/lib/types';
import { PRESET_CATALOG, recipientModeLabel } from '@/lib/capabilities';
import { shortAddr } from '@/lib/format';
import { Disclosure } from '@/components/ui/Disclosure';

type Phase = 'propose' | 'apply';

export function CapabilityGrant({
  onResolvePreset,
  onGrantPresetRule,
  onApplyCallRule,
  onRecordPreset,
  onCustomRule,
  onProposeBudget,
  onApplyBudget,
}: {
  /** FR3 (F-8b): owner signs the budget propose (version-aware in chain.ts) — timelocked. */
  onProposeBudget?: (token: string, windowCap: string) => Promise<void>;
  /** FR3 (F-8b): owner signs the budget apply once the pending eta passed. V6 re-submits the
   *  same (token, windowCap) payload for the on-chain commit check, so the form passes them. */
  onApplyBudget?: (token: string, windowCap: string) => Promise<void>;
} & {
  /** Preview a preset's resolved rules (no signing). */
  onResolvePreset: (key: PresetKey) => Promise<ResolvedPreset>;
  /** Owner signs proposeCallRule for one rule of the preset; resolves to the txHash. */
  onGrantPresetRule: (rule: CallRule) => Promise<string>;
  /** Owner signs applyCallRule (after a rule's eta). */
  onApplyCallRule: () => Promise<void>;
  /** Record the applied-preset read-model after a rule was signed. */
  onRecordPreset: (key: PresetKey, txHash: string) => Promise<void>;
  /** Owner signs the matching chain helper for a custom rule, then records it. */
  onCustomRule: (action: CapabilityRuleAction, rule: CallRule) => Promise<void>;
}) {
  return (
    <section
      aria-label="Grant a capability"
      className="card"
      data-testid="capability-grant"
      style={{ padding: '1rem 1.1rem', display: 'grid', gap: '1rem' }}
    >
      <h2 style={{ fontSize: '1rem', margin: 0 }}>Give this agent a new capability</h2>
      <PresetPicker
        onResolvePreset={onResolvePreset}
        onGrantPresetRule={onGrantPresetRule}
        onApplyCallRule={onApplyCallRule}
        onRecordPreset={onRecordPreset}
      />
      <CustomRuleForm onCustomRule={onCustomRule} />
      {onProposeBudget && onApplyBudget ? (
        <SpendBudgetForm onProposeBudget={onProposeBudget} onApplyBudget={onApplyBudget} />
      ) : null}
    </section>
  );
}

// ─── Token spending budget (FR3, F-8b) ────────────────────────────────────────
// Governed ERC-20 calls are FAIL-CLOSED without a per-token budget (BudgetNotSet)
// — this is the missing owner surface that sets one. Propose is timelocked
// (~15 min safety delay) like any loosen; apply flips it live after the eta.

function SpendBudgetForm({
  onProposeBudget,
  onApplyBudget,
}: {
  onProposeBudget: (token: string, windowCap: string) => Promise<void>;
  onApplyBudget: (token: string, windowCap: string) => Promise<void>;
}) {
  const [token, setToken] = useState('');
  const [windowCap, setWindowCap] = useState('');
  const [phase, setPhase] = useState<Phase>('propose');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function propose(e: React.FormEvent) {
    e.preventDefault();
    if (!ADDR_RE.test(token.trim())) return setError('Enter a valid token address (0x…, 40 hex).');
    if (!/^\d+$/.test(windowCap.trim())) return setError('Enter the budget as a whole base-unit number.');
    setBusy(true);
    setError(null);
    try {
      await onProposeBudget(token.trim(), windowCap.trim());
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
      await onApplyBudget(token.trim(), windowCap.trim());
      setToken('');
      setWindowCap('');
      setPhase('propose');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The wallet transaction failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void propose(e)} data-testid="spend-budget-form" style={{ display: 'grid', gap: '0.6rem' }}>
      <h3 className="label" style={{ margin: 0 }}>Set a token spending budget</h3>
      <p style={{ margin: 0, fontSize: '0.84rem', color: 'var(--ink-dim)' }}>
        Contract calls that move an ERC-20 are refused on-chain until the token has a budget. The
        budget is the most it can flow out, cumulatively, per window.
      </p>
      <label className="label" htmlFor="budget-token">Token</label>
      <input id="budget-token" className="field" data-testid="budget-token" value={token} onChange={(e) => setToken(e.target.value)} placeholder="0x…" disabled={busy || phase === 'apply'} />
      <label className="label" htmlFor="budget-cap">Budget (base units)</label>
      <input id="budget-cap" className="field" data-testid="budget-cap" inputMode="numeric" value={windowCap} onChange={(e) => setWindowCap(e.target.value)} placeholder="5000000000000000000000" disabled={busy || phase === 'apply'} />
      {error ? <p role="alert" style={{ color: 'var(--deny)', fontSize: '0.84rem', margin: 0 }}>{error}</p> : null}
      {phase === 'propose' ? (
        <div>
          <button type="submit" className="btn btn-primary btn-sm" data-testid="budget-propose" disabled={busy}>
            {busy ? 'Waiting for wallet…' : 'Propose budget'}
          </button>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '0.4rem' }}>
          <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--accent)' }}>
            Signed — this takes effect in ~15 min. Come back and apply it.
          </p>
          <div>
            <button type="button" className="btn btn-primary btn-sm" data-testid="budget-apply" disabled={busy} onClick={() => void apply()}>
              {busy ? 'Waiting for wallet…' : 'Apply budget'}
            </button>
          </div>
        </div>
      )}
    </form>
  );
}

// ─── Preset picker + sequential grant flow ───────────────────────────────────

function PresetPicker({
  onResolvePreset,
  onGrantPresetRule,
  onApplyCallRule,
  onRecordPreset,
}: {
  onResolvePreset: (key: PresetKey) => Promise<ResolvedPreset>;
  onGrantPresetRule: (rule: CallRule) => Promise<string>;
  onApplyCallRule: () => Promise<void>;
  onRecordPreset: (key: PresetKey, txHash: string) => Promise<void>;
}) {
  const [selected, setSelected] = useState<PresetKey | null>(null);
  const [preset, setPreset] = useState<ResolvedPreset | null>(null);
  const [step, setStep] = useState(0); // index into preset.rules
  const [phase, setPhase] = useState<Phase>('propose');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(key: PresetKey) {
    setSelected(key);
    setPreset(null);
    setError(null);
    setStep(0);
    setPhase('propose');
    setBusy(true);
    try {
      setPreset(await onResolvePreset(key));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load that preset.');
    } finally {
      setBusy(false);
    }
  }

  async function propose() {
    if (!preset || !selected) return;
    const rule = preset.rules[step];
    if (!rule) return;
    setBusy(true);
    setError(null);
    try {
      const txHash = await onGrantPresetRule(rule);
      await onRecordPreset(selected, txHash);
      setPhase('apply');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The wallet transaction failed.');
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!preset) return;
    setBusy(true);
    setError(null);
    try {
      await onApplyCallRule();
      if (step + 1 < preset.rules.length) {
        setStep(step + 1);
        setPhase('propose');
      } else {
        // Done — collapse back to the picker.
        setSelected(null);
        setPreset(null);
        setStep(0);
        setPhase('propose');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The wallet transaction failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: '0.7rem' }}>
      <h3 className="label" style={{ margin: 0 }}>Quick start with a preset</h3>
      {/* tools.html .presets grid of .preset cards (pn/pt/pd) — a card per real PRESET_CATALOG entry. */}
      <div className="presets" role="group" aria-label="Capability presets">
        {PRESET_CATALOG.map((p) => (
          <button
            key={p.key}
            type="button"
            className="preset"
            data-testid={`preset-${p.key}`}
            aria-pressed={selected === p.key}
            onClick={() => void pick(p.key)}
            disabled={busy}
          >
            <div className="pn">{p.name}</div>
            <div className="pt">{p.tag}</div>
            <div className="pd">{p.blurb}</div>
          </button>
        ))}
      </div>

      {error ? (
        <p role="alert" style={{ color: 'var(--deny)', fontSize: '0.84rem', margin: 0 }}>{error}</p>
      ) : null}

      {preset && preset.rules[step] ? (
        <div className="panel" data-testid="preset-flow" style={{ padding: '0.8rem', display: 'grid', gap: '0.6rem' }}>
          {(() => {
            const current = preset.rules[step]!;
            return (
              <>
          <p style={{ margin: 0, fontSize: '0.88rem' }}>
            <strong>{preset.label}</strong> grants {preset.rules.length} permission
            {preset.rules.length === 1 ? '' : 's'}. Each one is signed and waits a short safety
            delay before the next. <span className="badge">Step {step + 1} of {preset.rules.length}</span>
          </p>
          <p style={{ margin: 0, fontSize: '0.86rem' }}>
            This step: let it call {shortAddr(current.target)}, paying{' '}
            {recipientModeLabel(current.recipientMode)}, up to {current.perCallCap}{' '}
            per call.
          </p>
          <Disclosure label="Show the exact rule for this step">
            <dl style={{ margin: 0, display: 'grid', gap: '0.2rem' }}>
              <div>target: <span className="code">{current.target}</span></div>
              <div>selector: <span className="code">{current.selector}</span></div>
              <div>per-call cap: <span className="code">{current.perCallCap}</span></div>
              <div>window cap: <span className="code">{current.windowCapCall}</span></div>
            </dl>
          </Disclosure>
          {phase === 'propose' ? (
            <button type="button" className="btn btn-primary btn-sm" data-testid="preset-propose" disabled={busy} onClick={() => void propose()}>
              {busy ? 'Waiting for wallet…' : `Grant step ${step + 1}`}
            </button>
          ) : (
            <div style={{ display: 'grid', gap: '0.4rem' }}>
              <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--accent)' }}>
                Signed — this takes effect in ~15 min. Come back and apply it to continue.
              </p>
              <button type="button" className="btn btn-primary btn-sm" data-testid="preset-apply" disabled={busy} onClick={() => void apply()}>
                {busy ? 'Waiting for wallet…' : step + 1 < preset.rules.length ? 'Apply & go to next step' : 'Apply & finish'}
              </button>
            </div>
          )}
              </>
            );
          })()}
        </div>
      ) : null}
    </div>
  );
}

// ─── Custom rule form ─────────────────────────────────────────────────────────

const SELECTOR_RE = /^0x[0-9a-fA-F]{8}$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

function CustomRuleForm({ onCustomRule }: { onCustomRule: (action: CapabilityRuleAction, rule: CallRule) => Promise<void> }) {
  const [target, setTarget] = useState('');
  const [selector, setSelector] = useState('');
  const [perCall, setPerCall] = useState('');
  const [windowCap, setWindowCap] = useState('');
  const [mode, setMode] = useState<RecipientMode>('self');
  const [spenders, setSpenders] = useState('');
  const [action, setAction] = useState<CapabilityRuleAction>('propose');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ADDR_RE.test(target.trim())) return setError('Enter a valid contract address (0x…, 40 hex).');
    if (!SELECTOR_RE.test(selector.trim())) return setError('Enter a 4-byte selector (0x + 8 hex).');
    if (action !== 'remove' && (!/^\d+$/.test(perCall.trim()) || !/^\d+$/.test(windowCap.trim()))) {
      return setError('Enter per-call and window limits as whole base-unit numbers.');
    }
    const spenderSet = spenders
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (spenderSet.some((s) => !ADDR_RE.test(s))) return setError('Every spender must be a valid address.');

    const rule: CallRule = {
      target: target.trim() as CallRule['target'],
      selector: selector.trim().toLowerCase() as CallRule['selector'],
      recipientMode: mode,
      spenderSet: spenderSet as CallRule['spenderSet'],
      perCallCap: action === 'remove' ? '0' : perCall.trim(),
      windowCapCall: action === 'remove' ? '0' : windowCap.trim(),
    };
    setBusy(true);
    setError(null);
    try {
      await onCustomRule(action, rule);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The wallet transaction failed.');
    } finally {
      setBusy(false);
    }
  }

  const loosening = action === 'propose';

  return (
    <form onSubmit={(e) => void submit(e)} data-testid="custom-rule-form" style={{ display: 'grid', gap: '0.6rem' }}>
      <h3 className="label" style={{ margin: 0 }}>Or write a custom rule</h3>

      <label className="label" htmlFor="custom-action">What do you want to do?</label>
      <select
        id="custom-action"
        className="field"
        data-testid="custom-action"
        value={action}
        onChange={(e) => setAction(e.target.value as CapabilityRuleAction)}
        disabled={busy}
      >
        <option value="propose">Allow a new call (waits a safety delay)</option>
        <option value="tighten">Lower an existing limit (instant)</option>
        <option value="remove">Remove a permission (instant)</option>
      </select>

      <label className="label" htmlFor="custom-target">Contract it can call</label>
      <input id="custom-target" className="field" data-testid="custom-target" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="0x…" disabled={busy} />

      <label className="label" htmlFor="custom-selector">Function selector</label>
      <input id="custom-selector" className="field" data-testid="custom-selector" value={selector} onChange={(e) => setSelector(e.target.value)} placeholder="0x095ea7b3" disabled={busy} />

      {action !== 'remove' ? (
        <>
          <label className="label" htmlFor="custom-per-call">Per-call limit (base units)</label>
          <input id="custom-per-call" className="field" data-testid="custom-per-call" inputMode="numeric" value={perCall} onChange={(e) => setPerCall(e.target.value)} placeholder="100000000" disabled={busy} />

          <label className="label" htmlFor="custom-window-cap">Window limit (base units)</label>
          <input id="custom-window-cap" className="field" data-testid="custom-window-cap" inputMode="numeric" value={windowCap} onChange={(e) => setWindowCap(e.target.value)} placeholder="500000000" disabled={busy} />

          <label className="label" htmlFor="custom-mode">Who can it pay?</label>
          <select id="custom-mode" className="field" data-testid="custom-mode" value={mode} onChange={(e) => setMode(e.target.value as RecipientMode)} disabled={busy}>
            <option value="self">Only my own account</option>
            <option value="allowlist">An allowlist I set</option>
          </select>

          <label className="label" htmlFor="custom-spenders">Approved spenders (optional, comma-separated)</label>
          <input id="custom-spenders" className="field" data-testid="custom-spenders" value={spenders} onChange={(e) => setSpenders(e.target.value)} placeholder="0x… , 0x…" disabled={busy} />
        </>
      ) : null}

      {loosening ? (
        <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--accent)' }}>
          Allowing a new call loosens the leash, so it waits a short safety delay on-chain before
          it takes effect.
        </p>
      ) : null}

      <Disclosure label="What are a target and a selector?">
        The <strong>target</strong> is the contract address the agent may call. The{' '}
        <strong>selector</strong> is the first 4 bytes of the function it may call (e.g. 0x095ea7b3
        is ERC-20 approve). Together they name exactly one action; caps bound how much can flow.
      </Disclosure>

      {error ? <p role="alert" style={{ color: 'var(--deny)', fontSize: '0.84rem', margin: 0 }}>{error}</p> : null}

      <div>
        <button type="submit" className="btn btn-primary btn-sm" data-testid="custom-submit" disabled={busy}>
          {busy ? 'Waiting for wallet…' : action === 'propose' ? 'Propose rule' : action === 'tighten' ? 'Apply now' : 'Remove now'}
        </button>
      </div>
    </form>
  );
}
