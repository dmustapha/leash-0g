// File: web/components/cockpit/SendBlockedBanner.tsx
// AQ-FND S1: when one of an agent's transactions could not be resolved automatically, LEASH refuses to send
// anything more from that agent (so nothing can be paid twice) and tells the owner plainly, with the one action
// that unblocks it. Rendered only when the backend reports `sendBlock`.
'use client';

import { useState } from 'react';
import type { AgentDetail } from '@/lib/types';

export function SendBlockedBanner({
  block,
  onClear,
}: {
  block: NonNullable<AgentDetail['sendBlock']>;
  onClear: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function clear() {
    setBusy(true);
    setError(null);
    try {
      await onClear();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not clear it. Try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section role="alert" data-testid="send-blocked-banner" className="card" style={{ padding: '1rem 1.1rem', display: 'grid', gap: '0.6rem', borderColor: 'var(--deny)' }}>
      <strong>Sending is paused for this agent.</strong>
      <p style={{ margin: 0, fontSize: '0.9rem' }}>
        One of its transactions could not be resolved automatically: {block.reason}. LEASH will not send anything more
        from this agent until you have looked at it, so nothing can be paid twice.
      </p>
      {block.txHash ? (
        <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--ink-dim)' }}>
          Transaction: <span className="code">{block.txHash}</span> — check it on the network&apos;s block explorer.
        </p>
      ) : null}
      {error ? <p role="alert" style={{ margin: 0, color: 'var(--deny)', fontSize: '0.84rem' }}>{error}</p> : null}
      <div>
        <button type="button" className="btn btn-primary btn-sm" data-testid="send-blocked-clear" disabled={busy} onClick={() => void clear()}>
          {busy ? 'Clearing…' : "I've checked it — let it send again"}
        </button>
      </div>
    </section>
  );
}
