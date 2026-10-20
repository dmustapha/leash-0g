// File: web/app/jobs/[id]/page.tsx
// Phase-4 (spec §7, D-JOB-9): the full ACP job lifecycle view — live provider
// reasoning result, quarantined deliverable + verify, evaluator verdict, and
// the owner-supervised governed settlement (verdict-bound, on the shared
// approvals rail). Polls for lifecycle advances; the owner stream also nudges.
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { makeApi } from '@/lib/api';
import { useOwnerWallet } from '@/lib/owner-wallet';
import { useOwnerStream } from '@/lib/use-owner-stream';
import type { JobView, ApprovalDecision } from '@/lib/types';
import { JobLifecycle } from '@/components/cockpit/JobLifecycle';

export default function JobDetailPage() {
  const params = useParams<{ id: string }>();
  const jobId = params.id;
  const wallet = useOwnerWallet();
  const api = useMemo(() => makeApi(wallet.getToken), [wallet.getToken]);
  const [job, setJob] = useState<JobView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setJob(await api.getJob(jobId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load job');
    }
  }, [api, jobId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The lifecycle advances across several runtime cycles (deliver → evaluate →
  // verdict → settle); poll while it is not terminal so the view keeps up.
  useEffect(() => {
    if (!job) return;
    const terminal = job.status === 'settled' || job.status === 'rejected' || job.status === 'denied' || job.status === 'failed';
    if (terminal) return;
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [job, refresh]);

  // Owner stream: an alert or trace on any of the job's agents may signal a
  // lifecycle change — refetch (the server is the source of truth).
  useOwnerStream(() => {
    void refresh();
  });

  const onDecide = useCallback(
    async (approvalId: string, decision: ApprovalDecision) => {
      try {
        await api.decideApproval(approvalId, decision);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'decision failed');
      }
    },
    [api, refresh],
  );

  // G-2.3b: the shell topbar owns the "Jobs" title; `.ops-view` scopes the OPERATE styles.
  return (
    <div className="ops-view">
      <p className="section-title">
        ACP job · <span className="n">request → deliver → verify → settle</span>
      </p>
      {error ? (
        <div className="deadstate error" role="alert">
          <h4>Could not load this job</h4>
          <p>{error}</p>
          <button type="button" className="btn btn-ghost" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      ) : job ? (
        <JobLifecycle job={job} onDecide={onDecide} />
      ) : (
        <p role="status" style={{ color: 'var(--ink-dim)' }}>Loading…</p>
      )}
    </div>
  );
}
