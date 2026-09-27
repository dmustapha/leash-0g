// File: web/components/cockpit/DirectBox.tsx
// Phase-5.5 (spec §9): the cockpit COMMAND box. ONE plain box — "tell this agent what to do" —
// mirroring the create funnel's single-box shape (FunnelEntry). The owner types an intent; we
// read it back through the SAME ReadBack unit (direct mode) so a redirect is confirmed the way a
// create is. Newcomer copy on the surface; jargon behind a Disclosure. No em dashes in copy.
'use client';

import { useState } from 'react';
import type { ChainStep, DirectionDraft } from '@/lib/types';
import { ReadBack } from '@/components/create/ReadBack';
import type { ChainCandidate } from '@/components/cockpit/ChainPlanEditor';
import { Disclosure } from '@/components/ui/Disclosure';

export type DirectBoxProps = {
  /** Runs api.direct(agentId, { intent }); resolves to the quarantined draft + its id. */
  onDirect: (intent: string) => Promise<{ id: string; draft: DirectionDraft }>;
  /** Runs api.confirmDirection(agentId, directionId, { edited, recipient, chainPlan }). */
  onConfirm: (directionId: string, edited: DirectionDraft, recipient?: string, chainPlan?: ChainStep[]) => Promise<void>;
  /** Phase 5.6: the owner's OWN linked capabilities this agent can chain to (optional). */
  chainCandidates?: ChainCandidate[];
  chainConfig?: { maxDepth: number; maxEligiblePerHop: number };
};

export function DirectBox({ onDirect, onConfirm, chainCandidates, chainConfig }: DirectBoxProps) {
  const [intent, setIntent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [direction, setDirection] = useState<{ id: string; draft: DirectionDraft } | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  async function submit() {
    if (!intent.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      setDirection(await onDirect(intent.trim()));
    } catch {
      setError('I couldn’t read that just now. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  }

  async function confirm(edited: DirectionDraft, recipient?: string, chainPlan?: ChainStep[]) {
    if (!direction) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(direction.id, edited, recipient, chainPlan);
      setDirection(null);
      setIntent('');
      setConfirmed(true);
    } catch {
      setError('That redirect could not be saved. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (direction) {
    return (
      <ReadBack
        mode="direct"
        draft={direction.draft}
        onConfirm={(edited, recipient, chainPlan) => void confirm(edited, recipient, chainPlan)}
        onBack={() => setDirection(null)}
        {...(chainCandidates !== undefined ? { chainCandidates } : {})}
        {...(chainConfig !== undefined ? { chainConfig } : {})}
      />
    );
  }

  return (
    <section className="card" data-testid="direct-box" aria-label="Tell this agent what to do" style={{ padding: '1rem 1.1rem', display: 'grid', gap: '0.8rem' }}>
      <div style={{ display: 'grid', gap: '0.3rem' }}>
        <h2 style={{ fontSize: '1rem', margin: 0 }}>Tell this agent what to do</h2>
        <p style={{ margin: 0, fontSize: '0.86rem', color: 'var(--color-ink-dim)' }}>
          Describe the new task in plain words. I will read it back before anything changes.
        </p>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        style={{ display: 'grid', gap: '0.6rem' }}
      >
        <label className="label" htmlFor="direct-intent" style={{ color: 'var(--color-ink)' }}>
          What should it do next?
        </label>
        <textarea
          id="direct-intent"
          data-testid="direct-intent"
          className="field"
          rows={3}
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
          placeholder="e.g. keep the treasury topped up to 2 0G instead of 1"
          disabled={busy}
        />
        {error ? (
          <p role="alert" data-testid="direct-error" style={{ color: 'var(--color-deny)', fontSize: '0.85rem', margin: 0 }}>
            {error}
          </p>
        ) : null}
        {confirmed ? (
          <p role="status" data-testid="direct-confirmed" style={{ color: 'var(--color-allow, var(--color-ink))', fontSize: '0.85rem', margin: 0 }}>
            New task sent. The agent will pick it up on its next run.
          </p>
        ) : null}
        <div>
          <button type="submit" className="btn btn-primary btn-sm" data-testid="direct-submit" disabled={busy || !intent.trim()}>
            {busy ? 'Reading…' : 'Read it back'}
          </button>
        </div>
      </form>
      <Disclosure label="How does redirecting work?">
        This does not touch the agent’s spending limits or who it can pay. It only changes the task
        it is working on. Any limit change stays a separate, time-locked step in the Limits panel.
      </Disclosure>
    </section>
  );
}
