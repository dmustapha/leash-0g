// File: web/components/cockpit/StatusChat.tsx
// Phase-5.5 (spec §9): the cockpit QUESTION box. ONE box — "ask what it has done so far". This is
// a question, not a command, so it is visually distinct from DirectBox (a quiet panel, not a
// primary card). The answer is UNTRUSTED agent-authored text: rendered as PLAIN TEXT only — never
// dangerouslySetInnerHTML, never a markdown renderer — and labeled unverified. No em dashes.
'use client';

import { useState } from 'react';

export type StatusChatProps = {
  /** Runs api.agentStatus(agentId, q); resolves to the quarantined answer text. */
  onAsk: (q: string) => Promise<{ answer: string; asOfSeq: number }>;
};

export function StatusChat({ onAsk }: StatusChatProps) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);

  async function submit() {
    if (!q.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await onAsk(q.trim());
      setAnswer(res.answer);
    } catch {
      setError('I couldn’t reach the agent just now. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="panel"
      data-testid="status-chat"
      aria-label="Ask what it has done so far"
      style={{ padding: '1rem 1.1rem', display: 'grid', gap: '0.8rem' }}
    >
      <div style={{ display: 'grid', gap: '0.3rem' }}>
        <h2 style={{ fontSize: '1rem', margin: 0 }}>Ask what it has done so far</h2>
        <p style={{ margin: 0, fontSize: '0.86rem', color: 'var(--color-ink-dim)' }}>
          A quick question to the agent. Its answer comes from its own notes, so treat it as a
          summary, not a record.
        </p>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        style={{ display: 'grid', gap: '0.6rem' }}
      >
        <label className="label" htmlFor="status-chat-q" style={{ color: 'var(--color-ink)' }}>
          Your question
        </label>
        <textarea
          id="status-chat-q"
          data-testid="status-chat-q"
          className="field"
          rows={2}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="e.g. what have you paid out today?"
          disabled={busy}
        />
        {error ? (
          <p role="alert" data-testid="status-chat-error" style={{ color: 'var(--color-deny)', fontSize: '0.85rem', margin: 0 }}>
            {error}
          </p>
        ) : null}
        <div>
          <button type="submit" className="btn btn-ghost btn-sm" data-testid="status-chat-ask" disabled={busy || !q.trim()}>
            {busy ? 'Asking…' : 'Ask'}
          </button>
        </div>
      </form>
      {answer !== null ? (
        <div data-testid="status-chat-answer-wrap" style={{ display: 'grid', gap: '0.35rem' }}>
          <span className="badge" data-testid="status-chat-unverified">
            unverified — from the agent’s own notes
          </span>
          {/* UNTRUSTED text — rendered as PLAIN TEXT (no HTML, no markdown). */}
          <p
            data-testid="status-chat-answer"
            aria-live="polite"
            style={{ margin: 0, fontSize: '0.9rem', whiteSpace: 'pre-wrap' }}
          >
            {answer}
          </p>
        </div>
      ) : null}
    </section>
  );
}
