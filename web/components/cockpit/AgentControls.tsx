// File: web/components/cockpit/AgentControls.tsx
// Pause/resume the runtime and rotate the gateway token (new token shown once).
'use client';

import { useState } from 'react';
import type { AgentStatus } from '@/lib/types';
import { CopyButton } from '@/components/ui/CopyButton';

export function AgentControls({
  status,
  onStart,
  onStop,
  onRotate,
}: {
  status: AgentStatus;
  onStart: () => Promise<void>;
  onStop: () => Promise<void>;
  onRotate: () => Promise<string>; // returns the new gateway token
}) {
  const [busy, setBusy] = useState<'run' | 'rotate' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);

  async function run(kind: 'run' | 'rotate', fn: () => Promise<unknown>) {
    setBusy(kind);
    setError(null);
    try {
      const out = await fn();
      if (kind === 'rotate' && typeof out === 'string') setNewToken(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work. Try again.');
    } finally {
      setBusy(null);
    }
  }

  if (status === 'revoked') return null;

  return (
    <div style={{ display: 'grid', gap: '0.5rem' }}>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        {status === 'running' ? (
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => void run('run', onStop)} data-testid="pause-btn">
            {busy === 'run' ? 'Pausing…' : 'Pause agent'}
          </button>
        ) : (
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => void run('run', onStart)} data-testid="resume-btn">
            {busy === 'run' ? 'Starting…' : 'Resume agent'}
          </button>
        )}
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => void run('rotate', onRotate)} data-testid="rotate-btn">
          {busy === 'rotate' ? 'Rotating…' : 'Rotate gateway token'}
        </button>
      </div>
      {newToken ? (
        <div className="panel" style={{ padding: '0.6rem 0.8rem', display: 'flex', gap: '0.6rem', alignItems: 'center', justifyContent: 'space-between' }} role="status">
          <span style={{ fontSize: '0.8rem', color: 'var(--color-ink-dim)' }}>
            New token (shown once): <code className="code" style={{ color: 'var(--color-accent)' }}>{newToken}</code>
          </span>
          <CopyButton text={newToken} />
        </div>
      ) : null}
      {error ? (
        <p role="alert" style={{ color: 'var(--color-deny)', fontSize: '0.84rem' }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
