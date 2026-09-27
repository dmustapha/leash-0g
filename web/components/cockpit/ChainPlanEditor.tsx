// File: web/components/cockpit/ChainPlanEditor.tsx
// Phase 5.6 (spec §3a/§7.C) — the chain-plan editor, FOLDED into the direct-mode
// read-back (one confirm covers directive + plan). feedback_ui_easy_to_use: it is
// OPTIONAL and collapsed by default (no cockpit crowding) — "Then hand the result
// to…". Each hop picks one or more of the owner's OWN linked capabilities
// (server-state, never an address) + an owner-authored, plain-language intent.
// Suggested targets, if any, are dismissible HINTS, never pre-selected (never-guess).
'use client';

import { useState } from 'react';
import type { ChainStep } from '@/lib/types';
import { Disclosure } from '@/components/ui/Disclosure';

export type ChainCandidate = { id: string; label: string };

export type ChainPlanEditorProps = {
  /** The owner's OWN linked capabilities that can be chain targets (server-state). */
  candidates: ChainCandidate[];
  maxDepth: number;
  maxEligiblePerHop: number;
  value: ChainStep[];
  onChange: (plan: ChainStep[]) => void;
};

export function ChainPlanEditor({ candidates, maxDepth, maxEligiblePerHop, value, onChange }: ChainPlanEditorProps) {
  const [open, setOpen] = useState(value.length > 0);

  function addHop() {
    if (value.length >= maxDepth) return;
    onChange([...value, { eligibleTargetIds: [], directedIntent: '' }]);
  }
  function removeHop(i: number) {
    onChange(value.filter((_, idx) => idx !== i));
  }
  function setIntent(i: number, intent: string) {
    onChange(value.map((h, idx) => (idx === i ? { ...h, directedIntent: intent } : h)));
  }
  function toggleTarget(i: number, id: string) {
    onChange(
      value.map((h, idx) => {
        if (idx !== i) return h;
        const has = h.eligibleTargetIds.includes(id);
        if (has) return { ...h, eligibleTargetIds: h.eligibleTargetIds.filter((t) => t !== id) };
        if (h.eligibleTargetIds.length >= maxEligiblePerHop) return h; // cap enforced in UI too
        return { ...h, eligibleTargetIds: [...h.eligibleTargetIds, id] };
      }),
    );
  }

  if (candidates.length === 0) {
    return (
      <section data-testid="chain-plan-empty" className="panel" style={{ padding: '0.8rem 0.9rem' }}>
        <p style={{ margin: 0, fontSize: '0.86rem', color: 'var(--color-ink-dim)' }}>
          To hand this agent’s result to another of your agents, first link a capability to it. Then
          you can build a chain here.
        </p>
      </section>
    );
  }

  if (!open) {
    return (
      <div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          data-testid="chain-plan-open"
          onClick={() => {
            setOpen(true);
            if (value.length === 0) addHop();
          }}
        >
          + Then hand the result to another agent…
        </button>
      </div>
    );
  }

  return (
    <section
      data-testid="chain-plan-editor"
      aria-label="Hand the result to another agent"
      className="panel"
      style={{ padding: '1rem 1.1rem', display: 'grid', gap: '0.9rem' }}
    >
      <div style={{ display: 'grid', gap: '0.25rem' }}>
        <h3 style={{ fontSize: '0.98rem', margin: 0 }}>Then hand the result to…</h3>
        <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--color-ink-dim)' }}>
          Each step passes this agent’s output to one of your own agents, as a task it re-reasons on
          under its own leash. You approve any step that can spend money.
        </p>
      </div>

      {value.map((hop, i) => (
        <div key={i} data-testid={`chain-hop-${i}`} className="panel" style={{ padding: '0.8rem 0.9rem', display: 'grid', gap: '0.6rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="label" style={{ color: 'var(--color-ink)' }}>Step {i + 1}</span>
            <button type="button" className="btn btn-ghost btn-sm" data-testid={`chain-hop-remove-${i}`} onClick={() => removeHop(i)}>
              Remove
            </button>
          </div>
          <div style={{ display: 'grid', gap: '0.3rem' }}>
            <span className="label" style={{ color: 'var(--color-ink)' }}>
              Which of your agents can it hand off to?{' '}
              {hop.eligibleTargetIds.length > 1 ? '(it picks one at run time)' : ''}
            </span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
              {candidates.map((c) => {
                const on = hop.eligibleTargetIds.includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    data-testid={`chain-target-${i}-${c.id}`}
                    aria-pressed={on}
                    className={on ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm'}
                    onClick={() => toggleTarget(i, c.id)}
                  >
                    {c.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div style={{ display: 'grid', gap: '0.3rem' }}>
            <label htmlFor={`chain-intent-${i}`} className="label" style={{ color: 'var(--color-ink)' }}>
              What should it do with the result?
            </label>
            <textarea
              id={`chain-intent-${i}`}
              data-testid={`chain-intent-${i}`}
              className="field"
              rows={2}
              value={hop.directedIntent}
              placeholder="e.g. rebalance the treasury based on this analysis"
              onChange={(e) => setIntent(i, e.target.value)}
            />
          </div>
        </div>
      ))}

      <div style={{ display: 'flex', gap: '0.5rem' }}>
        {value.length < maxDepth ? (
          <button type="button" className="btn btn-ghost btn-sm" data-testid="chain-add-hop" onClick={addHop}>
            + Add another step
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          data-testid="chain-plan-clear"
          onClick={() => {
            onChange([]);
            setOpen(false);
          }}
        >
          Clear chain
        </button>
      </div>

      <Disclosure label="How does a chain stay safe?">
        Every step is one of your own agents on a link you already made. This agent’s output is
        untrusted input to the next one — it can’t hand over spending power. Any step that can move
        money still asks for your approval, and each agent stays inside its own on-chain limits.
      </Disclosure>
    </section>
  );
}
