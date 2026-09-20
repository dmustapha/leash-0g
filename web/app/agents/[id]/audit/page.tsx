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

  return (
    <div className="wrap" style={{ paddingBlock: 'clamp(1.5rem, 4vw, 3rem)', display: 'grid', gap: '1.1rem' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '1rem' }}>
        <h1 style={{ fontSize: 'var(--text-h1)' }}>Audit trail</h1>
        <span style={{ flex: 1 }} />
        <Link href={`/agents/${id}`} className="nav-link">
          ← Cockpit
        </Link>
      </div>

      {!wallet.ready ? (
        <p role="status" style={{ color: 'var(--color-ink-dim)' }}>Loading…</p>
      ) : !wallet.authenticated ? (
        <div className="card" style={{ padding: '1.4rem', display: 'grid', gap: '0.8rem', justifyItems: 'start' }}>
          <p>Connect your wallet to read your agent&apos;s audit trail.</p>
          <button type="button" className="btn btn-primary" onClick={wallet.login}>
            Connect wallet
          </button>
        </div>
      ) : error && !batches ? (
        <div className="toast toast-err" role="alert">
          <p>{error}</p>
          <button type="button" className="btn btn-sm" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : batches === null ? (
        <p role="status" style={{ color: 'var(--color-ink-dim)' }}>Loading batches…</p>
      ) : (
        <AuditView batches={batches} storedBlob={storedBlob} signMessage={wallet.signMessage} />
      )}
    </div>
  );
}
