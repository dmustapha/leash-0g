// File: web/app/agents/[id]/audit/page.tsx
// Audit page: loads batches + the stored encrypted key blob, hands off to AuditView.
'use client';

import { use, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { makeApi } from '@/lib/api';
import { useOwnerWallet } from '@/lib/owner-wallet';
import type { AuditBatch } from '@/lib/types';
import { AuditView } from '@/components/audit/AuditView';

export default function AuditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const wallet = useOwnerWallet();
  const api = useMemo(() => makeApi(wallet.getToken), [wallet.getToken]);

  const [batches, setBatches] = useState<AuditBatch[] | null>(null);
  const [storedBlob, setStoredBlob] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [b, detail] = await Promise.all([api.getAudit(id), api.getAgent(id)]);
      setBatches(b);
      setStoredBlob(detail.encryptedAuditKey ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the audit trail.');
    }
  }, [api, id]);

  useEffect(() => {
    if (wallet.authenticated) void load();
  }, [load, wallet.authenticated]);

  // G-2.4: the shell topbar owns the "Audit" title; `.trust-view` scopes the TRUST styles.
  return (
    <div className="trust-view">
      <div className="fleet-head">
        <p className="section-title" style={{ margin: 0 }}>
          Hash-chained trace batches · <span className="n">0G Storage</span>
        </p>
        <span className="grow" />
        <span className="hash"><Link href={`/agents/${id}`}>← Cockpit</Link></span>
      </div>

      {!wallet.ready ? (
        <p role="status" style={{ color: 'var(--ink-dim)' }}>Loading…</p>
      ) : !wallet.authenticated ? (
        <div className="deadstate">
          <svg className="leash-svg" viewBox="0 0 80 44" aria-hidden="true">
            <circle className="leash-clasp" cx="10" cy="22" r="6" />
            <path className="leash-path" d="M16 22 Q 40 30 74 22" />
          </svg>
          <h4>Connect your wallet</h4>
          <p>Sign in to read your agent&apos;s audit trail — the hash-chained record of everything it did.</p>
          <button type="button" className="btn btn-primary" onClick={wallet.login}>
            Connect wallet
          </button>
        </div>
      ) : error && !batches ? (
        <div className="deadstate error" role="alert">
          <h4>Could not load the audit trail</h4>
          <p>{error}</p>
          <button type="button" className="btn btn-ghost" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : batches === null ? (
        <p role="status" style={{ color: 'var(--ink-dim)' }}>Loading batches…</p>
      ) : (
        <AuditView
          batches={batches}
          storedBlob={storedBlob}
          signMessage={wallet.signMessage}
          ownerAddress={wallet.address}
        />
      )}
    </div>
  );
}
