// File: web/components/cockpit/SigningGrantPanel.tsx
// RH2 B2 (TA-ABI-5 close) — the OWNER governed-signing grant surface. This is the surface that did
// not exist before: web shipped no V5 signing path, so the only way to arm a session-key signing
// authority was the [DEPLOY] script. This panel lets an owner, through the shipped product:
//   • see the reviewed, grantable signing descriptors (erc2612 / permit2-single / permit2-batch /
//     CoW order) + the standing grants already armed (read-model mirror of the on-chain wall);
//   • PROPOSE a signing grant (proposeSigningGrantNested) — a LOOSEN, timelocked ~15 min → APPLY
//     (applySigningGrant) after the delay; TIGHTEN (instant) + REMOVE (instant).
//
// Shown ONLY for accountVersion===5 accounts (V4 has no governed-signing grammar). Non-custodial:
// the owner signs every tx via Privy; the backend only records the read-model mirror. The decoded
// grant intent is rendered as PLAIN TEXT labeled UNVERIFIED — never innerHTML / markdown.
'use client';

import { useMemo, useState } from 'react';
import type { SigningDescriptorView, SigningGrantAction, SigningRuleView } from '@/lib/types';
import { shortAddr } from '@/lib/format';
import { Disclosure } from '@/components/ui/Disclosure';

type Phase = 'propose' | 'apply';

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/** What the owner signs for a propose. Mirrors chain.ts SigningGrantInput's owner-authored half. */
export type ProposeGrantArgs = {
  descriptor: SigningDescriptorView;
  spenders: string[];
  perIntentCap: string;
  maxDeadlineWindow: number;
  token: string;
};

export function SigningGrantPanel({
  available,
  rules,
  onProposeGrant,
  onApplyGrant,
  onTightenGrant,
  onRemoveGrant,
}: {
  /** Reviewed, grantable descriptors (from GET /signing → available). */
  available: SigningDescriptorView[];
  /** Standing grants already armed (read-model mirror). */
  rules: SigningRuleView[];
  /** Owner signs proposeSigningGrantNested (loosen, timelocked) → records the read-model. */
  onProposeGrant: (args: ProposeGrantArgs) => Promise<void>;
  /** Owner signs applySigningGrant once the pending grant's eta passed. */
  onApplyGrant: () => Promise<void>;
  /** Owner signs tightenSigningGrant (instant) → records the read-model. */
  onTightenGrant: (args: {
    descriptor: SigningDescriptorView;
    perIntentCap: string;
    maxDeadlineWindow: number;
    token: string;
    spenders: string[];
  }) => Promise<void>;
  /** Owner signs removeSigningDescriptor (instant) → records the read-model removal. */
  onRemoveGrant: (descriptor: SigningDescriptorView) => Promise<void>;
}) {
  const byId = useMemo(() => new Map(rules.map((r) => [r.descriptorId, r])), [rules]);

  return (
    <section
      aria-label="Signing grants"
      className="card"
      data-testid="signing-grant-panel"
      style={{ padding: '1rem 1.1rem', display: 'grid', gap: '1rem' }}
    >
      <div style={{ display: 'grid', gap: '0.3rem' }}>
        <h2 style={{ fontSize: '1rem', margin: 0 }}>Let this agent sign for a protocol</h2>
        <p style={{ margin: 0, fontSize: '0.84rem', color: 'var(--color-ink-dim)' }}>
          A signing grant lets the agent&apos;s session key sign a specific off-chain message (an
          approval permit, a swap order) under caps you set. You sign every grant from your own
          wallet — nothing is armed until you turn it on here.
        </p>
      </div>

      {available.length === 0 ? (
        <p data-testid="signing-empty" style={{ margin: 0, fontSize: '0.86rem', color: 'var(--color-ink-dim)' }}>
          No signing protocols are available to grant on this account yet.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.7rem' }}>
          {available.map((d) => (
            <li key={d.descriptorId}>
              <DescriptorRow
                descriptor={d}
                current={byId.get(d.descriptorId)}
                onProposeGrant={onProposeGrant}
                onApplyGrant={onApplyGrant}
                onTightenGrant={onTightenGrant}
                onRemoveGrant={onRemoveGrant}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ─── One descriptor: its state + the propose→apply / tighten / remove flow ─────

function DescriptorRow({
  descriptor,
  current,
  onProposeGrant,
  onApplyGrant,
  onTightenGrant,
  onRemoveGrant,
}: {
  descriptor: SigningDescriptorView;
  current: SigningRuleView | undefined;
  onProposeGrant: (args: ProposeGrantArgs) => Promise<void>;
  onApplyGrant: () => Promise<void>;
  onTightenGrant: (args: {
    descriptor: SigningDescriptorView;
    perIntentCap: string;
    maxDeadlineWindow: number;
    token: string;
    spenders: string[];
  }) => Promise<void>;
  onRemoveGrant: (descriptor: SigningDescriptorView) => Promise<void>;
}) {
  const [action, setAction] = useState<SigningGrantAction>('propose');
  const [spenders, setSpenders] = useState('');
  const [perIntentCap, setPerIntentCap] = useState('');
  const [maxDeadlineWindow, setMaxDeadlineWindow] = useState('3600');
  const [token, setToken] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [phase, setPhase] = useState<Phase>('propose');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const grant = descriptor.onChainGrant;
  const isBatch = grant.kind === 2;
  const isOrder = grant.kind === 1;
  const active = Boolean(current?.active);

  function reset() {
    setSpenders('');
    setPerIntentCap('');
    setMaxDeadlineWindow('3600');
    setToken('');
    setConfirm(false);
    setPhase('propose');
  }

  function validate(): { spenderSet: string[]; cap: string; window: number; token: string } | null {
    const spenderSet = spenders.split(',').map((s) => s.trim()).filter(Boolean);
    if (spenderSet.some((s) => !ADDR_RE.test(s))) {
      setError('Every approved spender must be a valid address (0x…, 40 hex).');
      return null;
    }
    if (action !== 'remove') {
      if (!/^\d+$/.test(perIntentCap.trim()) || perIntentCap.trim() === '0') {
        setError('Enter the per-signature cap as a whole base-unit number.');
        return null;
      }
      const w = Number(maxDeadlineWindow.trim());
      if (!Number.isInteger(w) || w < 0 || w > 31_536_000) {
        setError('Enter a deadline window in seconds (0 to 31536000).');
        return null;
      }
      if (!ADDR_RE.test(token.trim())) {
        setError('Enter the spend token address (0x…, 40 hex).');
        return null;
      }
      return { spenderSet, cap: perIntentCap.trim(), window: w, token: token.trim() };
    }
    return { spenderSet, cap: '0', window: 0, token: token.trim() };
  }

  async function submitPropose() {
    const v = validate();
    if (!v) return;
    if (!confirm) {
      setError('Confirm the signing grant before you sign it.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onProposeGrant({
        descriptor,
        spenders: v.spenderSet,
        perIntentCap: v.cap,
        maxDeadlineWindow: v.window,
        token: v.token,
      });
      setPhase('apply');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The wallet transaction failed.');
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    setBusy(true);
    setError(null);
    try {
      await onApplyGrant();
      reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The wallet transaction failed.');
    } finally {
      setBusy(false);
    }
  }

  async function submitTighten() {
    const v = validate();
    if (!v) return;
    if (!confirm) {
      setError('Confirm the tightened grant before you sign it.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onTightenGrant({
        descriptor,
        perIntentCap: v.cap,
        maxDeadlineWindow: v.window,
        token: v.token,
        spenders: v.spenderSet,
      });
      reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The wallet transaction failed.');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await onRemoveGrant(descriptor);
      reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The wallet transaction failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="panel"
      data-testid={`signing-descriptor-${descriptor.descriptorId}`}
      style={{ padding: '0.85rem 0.9rem', display: 'grid', gap: '0.7rem' }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', flexWrap: 'wrap' }}>
        <strong style={{ fontSize: '0.95rem' }}>{descriptor.label}</strong>
        <span className="badge">{descriptor.protocol}</span>
        {descriptor.sensitive ? <span className="badge">always-ask</span> : null}
        {active ? (
          <span
            className="badge"
            data-testid={`signing-active-${descriptor.descriptorId}`}
            style={{ color: 'var(--color-accent)' }}
          >
            armed
          </span>
        ) : null}
      </div>

      {/* Decoded grant intent — PLAIN TEXT, labeled UNVERIFIED. Never innerHTML/markdown. */}
      <div
        data-testid={`signing-intent-${descriptor.descriptorId}`}
        className="panel"
        style={{ padding: '0.6rem 0.7rem', display: 'grid', gap: '0.25rem', fontSize: '0.84rem' }}
      >
        <span className="label" style={{ color: 'var(--color-ink-dim)' }}>
          What it signs <span className="badge">UNVERIFIED</span>
        </span>
        <span>{describeGrant(descriptor)}</span>
      </div>

      {active && current ? (
        <dl
          data-testid={`signing-current-${descriptor.descriptorId}`}
          style={{ margin: 0, display: 'grid', gap: '0.15rem', fontSize: '0.82rem' }}
        >
          <div>per-signature cap: <span className="code">{current.perIntentCap}</span></div>
          <div>deadline window: <span className="code">{current.maxDeadlineWindow}s</span></div>
          <div>spend token: <span className="code">{shortAddr(current.token)}</span></div>
          {current.spenderSet.length > 0 ? (
            <div>spenders: <span className="code">{current.spenderSet.map(shortAddr).join(', ')}</span></div>
          ) : null}
        </dl>
      ) : null}

      <label className="label" htmlFor={`signing-action-${descriptor.descriptorId}`}>What do you want to do?</label>
      <select
        id={`signing-action-${descriptor.descriptorId}`}
        className="field"
        data-testid={`signing-action-${descriptor.descriptorId}`}
        value={action}
        onChange={(e) => {
          setAction(e.target.value as SigningGrantAction);
          setPhase('propose');
          setError(null);
        }}
        disabled={busy}
      >
        <option value="propose">Arm this signing grant (waits a safety delay)</option>
        <option value="tighten">Lower an existing cap (instant)</option>
        <option value="remove">Remove this signing grant (instant)</option>
      </select>

      {action !== 'remove' ? (
        <div style={{ display: 'grid', gap: '0.5rem' }}>
          <label className="label" htmlFor={`signing-cap-${descriptor.descriptorId}`}>
            Per-signature cap (base units)
          </label>
          <input
            id={`signing-cap-${descriptor.descriptorId}`}
            className="field"
            data-testid={`signing-cap-${descriptor.descriptorId}`}
            inputMode="numeric"
            value={perIntentCap}
            onChange={(e) => setPerIntentCap(e.target.value)}
            placeholder="1000000000000000000"
            disabled={busy || phase === 'apply'}
          />

          <label className="label" htmlFor={`signing-window-${descriptor.descriptorId}`}>
            Deadline window (seconds)
          </label>
          <input
            id={`signing-window-${descriptor.descriptorId}`}
            className="field"
            data-testid={`signing-window-${descriptor.descriptorId}`}
            inputMode="numeric"
            value={maxDeadlineWindow}
            onChange={(e) => setMaxDeadlineWindow(e.target.value)}
            placeholder="3600"
            disabled={busy || phase === 'apply'}
          />

          <label className="label" htmlFor={`signing-token-${descriptor.descriptorId}`}>
            {isOrder ? 'Sell token (pinned)' : 'Spend token'}
          </label>
          <input
            id={`signing-token-${descriptor.descriptorId}`}
            className="field"
            data-testid={`signing-token-${descriptor.descriptorId}`}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="0x…"
            disabled={busy || phase === 'apply'}
          />

          <label className="label" htmlFor={`signing-spenders-${descriptor.descriptorId}`}>
            Approved spenders (comma-separated)
          </label>
          <input
            id={`signing-spenders-${descriptor.descriptorId}`}
            className="field"
            data-testid={`signing-spenders-${descriptor.descriptorId}`}
            value={spenders}
            onChange={(e) => setSpenders(e.target.value)}
            placeholder="0x… , 0x…"
            disabled={busy || phase === 'apply'}
          />
          {isBatch ? (
            <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--color-ink-dim)' }}>
              This is a batch permit — the per-token caps are the reviewed allowlist pinned by the
              descriptor; the per-signature cap above bounds each leaf.
            </p>
          ) : null}
        </div>
      ) : null}

      <Disclosure label="Show the exact on-chain grant params">
        <dl style={{ margin: 0, display: 'grid', gap: '0.2rem', fontSize: '0.82rem' }}>
          <div>descriptorId: <span className="code">{grant.descriptorId}</span></div>
          <div>domainSeparator: <span className="code">{grant.domainSeparator}</span></div>
          <div>typeHash: <span className="code">{grant.typeHash}</span></div>
          <div>kind: <span className="code">{grant.kind}</span></div>
          <div>numFields: <span className="code">{grant.numFields}</span></div>
          {grant.tokenCaps.length > 0 ? (
            <div>
              tokenCaps:{' '}
              <span className="code">
                {grant.tokenCaps.map((c) => `${shortAddr(c.token)}:${c.cap}`).join(', ')}
              </span>
            </div>
          ) : null}
        </dl>
      </Disclosure>

      {action !== 'remove' ? (
        <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', fontSize: '0.84rem' }}>
          <input
            type="checkbox"
            data-testid={`signing-confirm-${descriptor.descriptorId}`}
            checked={confirm}
            onChange={(e) => setConfirm(e.target.checked)}
            disabled={busy || phase === 'apply'}
          />
          <span>
            I understand this lets the agent&apos;s session key sign {descriptor.label} messages under
            the caps above, and I am signing this grant from my own wallet.
          </span>
        </label>
      ) : null}

      {action === 'propose' && phase === 'propose' ? (
        <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--color-accent)' }}>
          Arming a signing grant loosens the leash, so it waits a short safety delay on-chain before
          it takes effect.
        </p>
      ) : null}

      {error ? (
        <p role="alert" style={{ color: 'var(--color-deny)', fontSize: '0.84rem', margin: 0 }}>
          {error}
        </p>
      ) : null}

      <div>
        {action === 'propose' ? (
          phase === 'propose' ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              data-testid={`signing-propose-${descriptor.descriptorId}`}
              disabled={busy}
              onClick={() => void submitPropose()}
            >
              {busy ? 'Waiting for wallet…' : 'Propose grant'}
            </button>
          ) : (
            <div style={{ display: 'grid', gap: '0.4rem' }}>
              <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--color-accent)' }}>
                Signed — this takes effect in ~15 min. Come back and apply it.
              </p>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                data-testid={`signing-apply-${descriptor.descriptorId}`}
                disabled={busy}
                onClick={() => void apply()}
              >
                {busy ? 'Waiting for wallet…' : 'Apply grant'}
              </button>
            </div>
          )
        ) : action === 'tighten' ? (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            data-testid={`signing-tighten-${descriptor.descriptorId}`}
            disabled={busy}
            onClick={() => void submitTighten()}
          >
            {busy ? 'Waiting for wallet…' : 'Tighten now'}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-danger btn-sm"
            data-testid={`signing-remove-${descriptor.descriptorId}`}
            disabled={busy}
            onClick={() => void remove()}
          >
            {busy ? 'Waiting for wallet…' : 'Remove now'}
          </button>
        )}
      </div>
    </div>
  );
}

/** Plain-language, UNVERIFIED description of what a descriptor lets the agent sign. Pure text
 *  derived from reviewed registry fields — never from model output, never rendered as HTML. */
function describeGrant(d: SigningDescriptorView): string {
  const g = d.onChainGrant;
  if (g.kind === 1) {
    return `A CoW swap order selling a pinned token for ${shortAddr(g.buyToken)}, capped per order.`;
  }
  if (g.kind === 2) {
    const n = g.tokenCaps.length;
    return `A batch Permit2 approval across ${n} reviewed token${n === 1 ? '' : 's'}, each capped.`;
  }
  return `A single ${d.protocol} approval permit for one token, capped per signature.`;
}
