// File: web/app/jobs/page.tsx
// Phase-4 (spec §7): the ACP jobs list page — every job the owner's agents run.
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { makeApi } from '@/lib/api';
import { useOwnerWallet } from '@/lib/owner-wallet';
import type { JobView } from '@/lib/types';
import { JobsList } from '@/components/cockpit/JobsList';

export default function JobsPage() {
  const wallet = useOwnerWallet();
  const api = useMemo(() => makeApi(wallet.getToken), [wallet.getToken]);
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await api.listJobs();
      setJobs(res.jobs);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load jobs');
    } finally {
      setLoaded(true);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <main style={{ display: 'grid', gap: '1rem', maxWidth: 720, margin: '0 auto', padding: '1.5rem' }}>
      <header style={{ display: 'grid', gap: '0.25rem' }}>
        <h1 style={{ margin: 0, fontSize: '1.2rem' }}>Jobs</h1>
        <p style={{ margin: 0, fontSize: '0.86rem', color: 'var(--color-ink-faint)' }}>
          Real agent-economy work under your leash: request → deliver → verify → settle.
        </p>
        <Link href="/jobs/specs" className="btn btn-ghost btn-sm" data-testid="define-job" style={{ justifySelf: 'start' }}>
          Define a job
        </Link>
      </header>
      {error ? <p style={{ color: 'var(--color-deny, #d66)', fontSize: '0.9rem' }}>{error}</p> : null}
      {loaded ? <JobsList jobs={jobs} /> : <p style={{ color: 'var(--color-ink-faint)' }}>Loading…</p>}
    </main>
  );
}
