// File: web/components/cockpit/JobsList.tsx
// Phase-4 (spec §7): the ACP job list — one row per job, status at a glance,
// linking to the full lifecycle view.
'use client';

import Link from 'next/link';
import type { JobView, JobStatus } from '@/lib/types';

const STATUS_TONE: Record<JobStatus, 'idle' | 'accent' | 'allow' | 'deny'> = {
  originated: 'idle',
  delivered: 'accent',
  evaluating: 'accent',
  verdict: 'accent',
  awaiting_approval: 'accent',
  settled: 'allow',
  rejected: 'deny',
  denied: 'deny',
  failed: 'deny',
};

export function JobsList({ jobs }: { jobs: JobView[] }) {
  if (jobs.length === 0) {
    return (
      <p data-testid="jobs-empty" style={{ color: 'var(--color-ink-faint)', fontSize: '0.9rem' }}>
        No jobs yet. A requester agent posts one from its seeded job spec.
      </p>
    );
  }
  return (
    <ul data-testid="jobs-list" style={{ display: 'grid', gap: '0.6rem', listStyle: 'none', margin: 0, padding: 0 }}>
      {jobs.map((job) => (
        <li key={job.jobId}>
          <Link
            href={`/jobs/${job.jobId}`}
            className="panel"
            data-testid={`job-row-${job.jobId}`}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', textDecoration: 'none' }}
          >
            <span style={{ fontSize: '0.9rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {job.spec.question}
            </span>
            <span className={`pill pill-${STATUS_TONE[job.status]}`}>{job.status.replace(/_/g, ' ')}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
