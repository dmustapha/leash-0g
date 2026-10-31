// File: web/components/cockpit/GasPolicyToggle.tsx
// AQ-FND M-3: the owner's opt-in for the relayer gas bootstrap. OFF by default — LEASH sponsors
// nothing unless the owner says so (D-4). The copy is deliberately honest: this is a
// convenience paid for up front by LEASH-ops and repaid from the agent's own tokens, NOT
// self-funding. Optimistic: flips at once, reverts with a message if the save fails.
'use client';

import { useState } from 'react';
import { Disclosure } from '@/components/ui/Disclosure';

export function GasPolicyToggle({
  initial,
  setGasPolicy,
}: {
  /** The persisted opt-in (agent.allowRelayerBootstrap). */
  initial: boolean;
  /** PATCH /api/agents/:id/gas-policy. Throws on failure. */
  setGasPolicy: (allowRelayerBootstrap: boolean) => Promise<unknown>;
}) {
  const [enabled, setEnabled] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    const next = !enabled;
    setEnabled(next); // optimistic
    setBusy(true);
    setError(null);
    try {
      await setGasPolicy(next);
    } catch (e) {
      setEnabled(!next); // revert
      setError(e instanceof Error ? `Couldn't save that: ${e.message}` : "Couldn't save that. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-label="Gas help"
      className="card"
      data-testid="gas-policy-toggle"
      style={{ padding: '1rem 1.1rem', display: 'grid', gap: '0.7rem' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <h2 style={{ fontSize: '1rem', margin: 0 }}>Gas help</h2>
        <span style={{ flex: 1 }} />
        <span className={enabled ? 'pill' : 'pill pill-idle'} data-testid="gas-policy-state">
          {enabled ? 'relayer allowed' : 'off'}
        </span>
      </div>
      <label style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start', cursor: busy ? 'progress' : 'pointer' }}>
        <input
          type="checkbox"
          role="switch"
          data-testid="gas-policy-switch"
          checked={enabled}
          disabled={busy}
          onChange={() => void toggle()}
          style={{ marginTop: '0.25rem' }}
        />
        <span style={{ fontSize: '0.88rem' }}>
          Let LEASH&apos;s relayer front the gas when the agent has none. LEASH-ops pays the network
          fee first and is repaid from the agent&apos;s own tokens. This is a convenience, not
          self-funding — leave it off to have the agent ask you instead.
        </span>
      </label>
      {error ? (
        <p role="alert" data-testid="gas-policy-error" style={{ color: 'var(--color-deny)', fontSize: '0.84rem', margin: 0 }}>
          {error}
        </p>
      ) : null}
      <Disclosure label="What does this change?">
        With this off (the default) an agent that has no gas anywhere will never use LEASH&apos;s
        relayer: it works out whether it can pay for gas itself on any network it is on, and if
        it cannot it raises one request to you saying exactly what is missing. With it on, the
        agent may use an EIP-7702 bootstrap: the relayer submits the agent&apos;s signed batch and
        is repaid in the same transaction, in the agent&apos;s token, through your spending limits.
        The agent must hold a token you have already allowed it to spend.
      </Disclosure>
    </section>
  );
}
