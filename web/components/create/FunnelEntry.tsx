// File: web/components/create/FunnelEntry.tsx
// Phase-5 (spec §3a): the NEW default /create front door. One intent box → spec-elevation, a
// TemplateStrip (reliable floor, no LLM call), and a small "set it up manually" escape to the
// existing role-first wizard. Fewer decisions than today: the intimidating role chooser is no
// longer the first thing a newcomer meets (D-B6).
'use client';

import { useState } from 'react';
import type { ElevationDraft } from '@/lib/types';
import { TemplateStrip } from './TemplateStrip';

export type FunnelEntryProps = {
  /** Runs spec-elevation (api.elevate). Rejects on failure — this component surfaces a retry. */
  onElevate: (intent: string) => Promise<void>;
  /** Template pick — loads a static draft straight into the read-back. */
  onPick: (draft: ElevationDraft) => void;
  /** Escape hatch to the role-first wizard (experts). */
  onManual: () => void;
};

export function FunnelEntry({ onElevate, onPick, onManual }: FunnelEntryProps) {
  const [intent, setIntent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!intent.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onElevate(intent.trim());
    } catch {
      // A legible retry, never a blank screen (D-B1).
      setError('I couldn’t read that just now. Try again, or start from a template below.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" data-testid="funnel-entry" style={{ padding: 'clamp(1.2rem, 3vw, 2rem)', display: 'grid', gap: '1.2rem' }}>
      <header style={{ display: 'grid', gap: '0.4rem' }}>
        <h1 style={{ fontSize: 'var(--text-h1)' }}>Create an agent</h1>
        <p style={{ color: 'var(--color-ink-dim)', fontSize: '0.95rem', margin: 0 }}>
          Describe what you want it to do, in plain words. I’ll set it up and show you exactly what
          I understood before anything is created.
        </p>
      </header>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        style={{ display: 'grid', gap: '0.7rem' }}
      >
        <label className="label" htmlFor="funnel-intent" style={{ color: 'var(--color-ink)' }}>
          What do you want your agent to do?
        </label>
        <textarea
          id="funnel-intent"
          data-testid="funnel-intent"
          className="field"
          rows={3}
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
          placeholder="e.g. give me calibrated odds on market questions"
          disabled={busy}
          autoFocus
        />
        {error ? (
          <p role="alert" data-testid="funnel-error" style={{ color: 'var(--color-deny)', fontSize: '0.85rem', margin: 0 }}>
            {error}
          </p>
        ) : null}
        <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
          <button type="submit" className="btn btn-primary" data-testid="funnel-elevate" disabled={busy || !intent.trim()}>
            {busy ? 'Reading…' : error ? 'Try again' : 'Continue'}
          </button>
          {busy ? (
            <span role="status" aria-live="polite" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem', color: 'var(--color-ink-dim)' }}>
              <span className="dot-live" aria-hidden="true" />
              Working out what you need…
            </span>
          ) : null}
        </div>
      </form>

      <TemplateStrip onPick={onPick} />

      <div style={{ borderTop: '1px solid var(--color-line-soft)', paddingTop: '0.9rem' }}>
        <button type="button" className="btn btn-ghost btn-sm" data-testid="funnel-manual" onClick={onManual}>
          I know what I want — set it up manually
        </button>
      </div>
    </section>
  );
}
