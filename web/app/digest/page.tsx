// File: web/app/digest/page.tsx
// Daily digest page: GET /api/digest preview; "Mark caught up" → POST /api/digest/mark, then
// show the marked digest and refresh the preview window.
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { makeApi } from '@/lib/api';
import { useOwnerWallet } from '@/lib/owner-wallet';
import type { Digest } from '@/lib/types';
import { DigestView } from '@/components/digest/DigestView';

export default function DigestPage() {
  const wallet = useOwnerWallet();
  const api = useMemo(() => makeApi(wallet.getToken), [wallet.getToken]);

  const [digest, setDigest] = useState<Digest | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setDigest((await api.getDigest()).digest);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load your digest.');
    }
  }, [api]);

  useEffect(() => {
    if (wallet.authenticated) void refresh();
  }, [wallet.authenticated, refresh]);

  const onMark = useCallback(async () => {
    await api.markDigest();
    await refresh();
  }, [api, refresh]);

  if (!wallet.ready) {
    return (
      <Shell>
        <p role="status" style={{ color: 'var(--color-ink-dim)' }}>Loading…</p>
      </Shell>
    );
  }
  if (!wallet.authenticated) {
    return (
      <Shell>
        <div className="card" style={{ padding: '1.4rem', display: 'grid', gap: '0.8rem', justifyItems: 'start' }}>
          <p>Connect your wallet to see your daily digest.</p>
          <button type="button" className="btn btn-primary" onClick={wallet.login}>
            Connect wallet
          </button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      {loadError && !digest ? (
        <div className="toast toast-err" role="alert">
          <p>We could not load your digest ({loadError}).</p>
          <button type="button" className="btn btn-sm" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      ) : digest ? (
        <DigestView digest={digest} onMark={onMark} />
      ) : (
        <p role="status" style={{ color: 'var(--color-ink-dim)' }}>Loading your digest…</p>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="wrap" style={{ paddingBlock: 'clamp(1.5rem, 4vw, 3rem)', display: 'grid', gap: '1.1rem', maxWidth: '860px' }}>
      <h1 style={{ fontSize: 'var(--text-h1)' }}>Daily digest</h1>
      {children}
    </div>
  );
}
