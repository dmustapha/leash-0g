// File: web/components/cockpit/SendBlockedBanner.tsx
// AQ-FND S1: when one of an agent's transactions could not be resolved automatically, LEASH stops sending from
// that agent (to avoid ever sending the same payment twice) and tells the owner plainly. There are two cases and the
// banner shows only the action that is SAFE for the case:
//   · the stuck tx could still go through  -> the only safe exit is to CANCEL it (replace it with a harmless no-op)
//   · it can no longer go through          -> the owner checks it and lets the agent send again
'use client';

import { useState } from 'react';
import type { AgentDetail } from '@/lib/types';

export function SendBlockedBanner({
  block,
  onClear,
  onCancel,
}: {
  block: NonNullable<AgentDetail['sendBlock']>;
  onClear: () => Promise<void>;
  onCancel: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work. Try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section role="alert" data-testid="send-blocked-banner" className="card" style={{ padding: '1rem 1.1rem', display: 'grid', gap: '0.6rem', borderColor: 'var(--deny)' }}>
      <strong>Sending is paused for this agent.</strong>
      <p style={{ margin: 0, fontSize: '0.9rem' }}>
        One of its transactions could not be resolved automatically: {block.reason}. LEASH has stopped sending from this
        agent so the same payment is never sent twice.
      </p>
      {block.txHash ? (
        <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--ink-dim)' }}>
          Transaction: <span className="code">{block.txHash}</span> — you can look it up on the network&apos;s block explorer.
        </p>
      ) : null}
      {block.pendingOnNetwork ? (
        <>
          <p style={{ margin: 0, fontSize: '0.86rem' }} data-testid="send-blocked-pending">
            That transaction is still waiting on the network and could still go through, so it is not safe to just resume.
            You can cancel it: it is replaced by a harmless no-op, and sending resumes once that lands.
          </p>
          <div>
            <button type="button" className="btn btn-primary btn-sm" data-testid="send-blocked-cancel" disabled={busy} onClick={() => void run(onCancel)}>
              {busy ? 'Cancelling…' : 'Cancel the waiting transaction'}
            </button>
          </div>
        </>
      ) : (
        <div>
          <button type="button" className="btn btn-primary btn-sm" data-testid="send-blocked-clear" disabled={busy} onClick={() => void run(onClear)}>
            {busy ? 'Resuming…' : "I've checked it — let it send again"}
          </button>
        </div>
      )}
      {error ? <p role="alert" style={{ margin: 0, color: 'var(--deny)', fontSize: '0.84rem' }}>{error}</p> : null}
    </section>
  );
}
