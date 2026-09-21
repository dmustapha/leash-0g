// File: web/components/links/LinkCreateForm.tsx
// Create an owner-authorized link between two of the owner's agents (spec §3c).
// Plain-language mode choice; inline warning when linking toward a revoked agent.
'use client';

import { useMemo, useState } from 'react';
import type { AgentSummary, LinkMode } from '@/lib/types';

const MODE_EXPLAIN: Record<LinkMode, string> = {
  auto: 'Handoffs flow immediately. The receiving agent still checks every request against its own on-chain limits.',
  supervised: 'Every handoff waits for your approval before it reaches the other agent.',
};

export function LinkCreateForm({
  agents,
  onCreate,
}: {
  agents: AgentSummary[];
  onCreate: (body: { fromAgentId: string; toAgentId: string; mode: LinkMode }) => Promise<void>;
}) {
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [mode, setMode] = useState<LinkMode>('auto');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toAgent = useMemo(() => agents.find((a) => a.agentId === toId), [agents, toId]);
  const targetWarning =
    toAgent && toAgent.status === 'revoked'
      ? `${toAgent.name} is revoked — handoffs sent to it will sit unanswered until they expire.`
      : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!fromId || !toId) {
      setError('Pick both agents.');
      return;
    }
    if (fromId === toId) {
      setError('An agent cannot hand work to itself. Pick two different agents.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCreate({ fromAgentId: fromId, toAgentId: toId, mode });
      setFromId('');
      setToId('');
      setMode('auto');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the link. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="card" data-testid="link-create-form" style={{ padding: '1rem 1.1rem', display: 'grid', gap: '0.8rem' }}>
      <h2 style={{ fontSize: '1rem' }}>Link two agents</h2>
      <p style={{ color: 'var(--color-ink-dim)', fontSize: '0.86rem' }}>
        A link lets one agent hand work to another. Without a link, agents cannot talk to each
        other at all.
      </p>
      <div style={{ display: 'grid', gap: '0.35rem' }}>
        <label htmlFor="link-from" className="label" style={{ color: 'var(--color-ink)' }}>
          From (the agent that asks)
        </label>
        <select id="link-from" className="field" value={fromId} onChange={(e) => setFromId(e.target.value)} disabled={busy}>
          <option value="">Pick an agent…</option>
          {agents.map((a) => (
            <option key={a.agentId} value={a.agentId}>
              {a.name} {a.status === 'revoked' ? '(revoked)' : ''}
            </option>
          ))}
        </select>
      </div>
      <div style={{ display: 'grid', gap: '0.35rem' }}>
        <label htmlFor="link-to" className="label" style={{ color: 'var(--color-ink)' }}>
          To (the agent that acts)
        </label>
        <select id="link-to" className="field" value={toId} onChange={(e) => setToId(e.target.value)} disabled={busy}>
          <option value="">Pick an agent…</option>
          {agents.map((a) => (
            <option key={a.agentId} value={a.agentId}>
              {a.name} {a.status === 'revoked' ? '(revoked)' : ''}
            </option>
          ))}
        </select>
      </div>
      {targetWarning ? (
        <p role="alert" data-testid="link-target-warning" style={{ color: 'var(--color-accent)', fontSize: '0.84rem' }}>
          {targetWarning}
        </p>
      ) : null}
      <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'grid', gap: '0.45rem' }}>
        <legend className="label" style={{ color: 'var(--color-ink)', padding: 0, marginBottom: '0.35rem' }}>
          How should handoffs work?
        </legend>
        {(['auto', 'supervised'] as const).map((m) => (
          <label key={m} style={{ display: 'flex', gap: '0.55rem', alignItems: 'flex-start', cursor: 'pointer' }}>
            <input
              type="radio"
              name="link-mode"
              value={m}
              checked={mode === m}
              onChange={() => setMode(m)}
              disabled={busy}
              style={{ marginTop: '0.25rem' }}
            />
            <span style={{ fontSize: '0.88rem' }}>
              <strong style={{ textTransform: 'capitalize' }}>{m === 'auto' ? 'Automatic' : 'Supervised'}</strong>
              <span style={{ display: 'block', color: 'var(--color-ink-dim)', fontSize: '0.82rem' }}>
                {MODE_EXPLAIN[m]}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      {error ? (
        <p role="alert" style={{ color: 'var(--color-deny)', fontSize: '0.85rem' }}>
          {error}
        </p>
      ) : null}
      <div>
        <button type="submit" className="btn btn-primary" disabled={busy} data-testid="create-link-btn">
          {busy ? 'Creating…' : 'Create link'}
        </button>
      </div>
    </form>
  );
}
