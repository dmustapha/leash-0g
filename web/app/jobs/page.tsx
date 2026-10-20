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

  // G-2.3b: the shell topbar owns the "Jobs" title; this view opens on its own
  // section eyebrow. `.ops-view` is the scope hook for the OPERATE styles in console.css.
  return (
    <div className="ops-view">
      <div className="fleet-head">
        <p className="section-title" style={{ margin: 0 }}>
          Agent commerce jobs · <span className="n">ACP lifecycle</span>
        </p>
        <span className="grow" />
        <Link href="/jobs/specs" className="btn btn-ghost btn-sm" data-testid="define-job">
          Define a job
        </Link>
      </div>
      {error ? (
        <div className="deadstate error" role="alert">
          <h4>Could not load your jobs</h4>
          <p>{error}</p>
          <button type="button" className="btn btn-ghost" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      ) : loaded ? (
        <JobsList jobs={jobs} />
      ) : (
        <p role="status" style={{ color: 'var(--ink-dim)' }}>Loading…</p>
      )}
    </div>
  );
}
