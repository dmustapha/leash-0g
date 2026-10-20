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
      <p role="status" style={{ color: 'var(--ink-dim)' }}>
        Loading…
      </p>
    );
  }
  if (!wallet.authenticated) {
    return (
      <div className="deadstate">
        <svg className="leash-svg" viewBox="0 0 80 44" aria-hidden="true">
          <circle className="leash-clasp" cx="10" cy="22" r="6" />
          <path className="leash-path" d="M16 22 Q 40 30 74 22" />
        </svg>
        <h4>Connect your wallet</h4>
        <p>Sign in for the daily glance — what each agent spent, blocked, and settled.</p>
        <button type="button" className="btn btn-primary" onClick={wallet.login}>
          Connect wallet
        </button>
      </div>
    );
  }

  if (loadError && !digest) {
    return (
      <div className="deadstate error" role="alert">
        <h4>Could not load your digest</h4>
        <p>{loadError}</p>
        <button type="button" className="btn btn-ghost" onClick={() => void refresh()}>
          Retry
        </button>
      </div>
    );
  }

  // The page title ("Digest") lives in the shell topbar; the view renders straight in.
  return digest ? (
    <DigestView digest={digest} onMark={onMark} />
  ) : (
    <p role="status" style={{ color: 'var(--ink-dim)' }}>
      Loading your digest…
    </p>
  );
}
