// File: web/components/settings/AlertPrefs.tsx
// Per-kind × channel alert preferences (spec §3c). In-app delivery is ALWAYS on — decision
// alerts especially can never be muted in-app (deny-by-default still stands, but you deserve
// to see them). Telegram is the per-kind toggle; S11 defaults: decision kinds ON, info OFF.
'use client';

import { useState } from 'react';
import type { AlertKind, AlertPrefs as Prefs } from '@/lib/types';

const KINDS: Array<{ kind: AlertKind; label: string; klass: 'decision' | 'info' }> = [
  { kind: 'approval_required', label: 'An agent needs your decision', klass: 'decision' },
  { kind: 'limit_hit', label: 'An agent hit one of its limits', klass: 'decision' },
  { kind: 'revoked', label: 'An agent was revoked', klass: 'info' },
  { kind: 'revoke_failed', label: 'A revoke did not go through', klass: 'info' },
  { kind: 'delegation_terminal', label: 'A handoff between agents ended', klass: 'info' },
  { kind: 'runtime_error', label: 'An agent kept erroring', klass: 'info' },
  { kind: 'throttle', label: 'Requests were throttled', klass: 'info' },
  { kind: 'alert_storm', label: 'Too many alerts at once (storm contained)', klass: 'info' },
];

/** S11 default at link time: decision-class ON, info-class OFF; explicit prefs override. */
export function telegramDefault(klass: 'decision' | 'info'): boolean {
  return klass === 'decision';
}

export function AlertPrefsPanel({
  prefs,
  onChange,
}: {
  prefs: Prefs;
  /** Receives the FULL merged prefs map — PATCH /api/owner/settings upstream. */
  onChange: (next: Prefs) => Promise<void>;
}) {
  const [busyKind, setBusyKind] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(kind: AlertKind, klass: 'decision' | 'info') {
    const current = prefs[kind]?.telegram ?? telegramDefault(klass);
    setBusyKind(kind);
    setError(null);
    try {
      await onChange({ ...prefs, [kind]: { telegram: !current } });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save that preference.');
    } finally {
      setBusyKind(null);
    }
  }

  return (
    <section aria-label="Alert preferences" className="card" style={{ padding: '1rem 1.1rem', display: 'grid', gap: '0.7rem' }}>
      <h2 style={{ fontSize: '1rem', margin: 0 }}>What reaches you where</h2>
      <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--color-ink-dim)' }}>
        Everything always lands in your in-app inbox — decisions can never be muted there.
        Telegram is up to you, per kind.
      </p>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.87rem' }}>
        <thead>
          <tr style={{ textAlign: 'left' }}>
            <th scope="col" className="label" style={{ paddingBottom: '0.4rem' }}>Alert</th>
            <th scope="col" className="label" style={{ paddingBottom: '0.4rem' }}>In-app</th>
            <th scope="col" className="label" style={{ paddingBottom: '0.4rem' }}>Telegram</th>
          </tr>
        </thead>
        <tbody>
          {KINDS.map(({ kind, label, klass }) => {
            const telegramOn = prefs[kind]?.telegram ?? telegramDefault(klass);
            return (
              <tr key={kind} style={{ borderTop: '1px solid var(--color-line-soft)' }}>
                <td style={{ padding: '0.45rem 0.6rem 0.45rem 0' }}>{label}</td>
                <td style={{ padding: '0.45rem 0.6rem 0.45rem 0' }}>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', color: 'var(--color-ink-dim)' }}>
                    <input
                      type="checkbox"
                      checked
                      disabled
                      aria-label={`In-app alerts for “${label}” — always on`}
                      data-testid={`inapp-${kind}`}
                    />
                    <span style={{ fontSize: '0.8rem' }}>
                      {klass === 'decision' ? 'always on (needs you)' : 'always on'}
                    </span>
                  </label>
                </td>
                <td style={{ padding: '0.45rem 0' }}>
                  <input
                    type="checkbox"
                    checked={telegramOn}
                    disabled={busyKind !== null}
                    aria-label={`Telegram alerts for “${label}”`}
                    data-testid={`telegram-${kind}`}
                    onChange={() => void toggle(kind, klass)}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {error ? (
        <p role="alert" style={{ color: 'var(--color-deny)', fontSize: '0.84rem', margin: 0 }}>
          {error}
        </p>
      ) : null}
    </section>
  );
}
