// File: web/components/cockpit/JobsList.tsx
// Phase-4 (spec §7): the ACP job list — one row per job, status at a glance,
// linking to the full lifecycle view.
'use client';

import Link from 'next/link';
import type { JobView, JobStatus } from '@/lib/types';
import { JobStepper, formatToken } from '@/components/cockpit/JobStepper';

// G-2.3b: each status maps to the console.html chip family (chip-allow / chip-deny /
// chip-pend). A neutral 'originated' carries no color (plain badge-pill).
const STATUS_CHIP: Record<JobStatus, string> = {
  originated: 'badge-pill',
  delivered: 'chip chip-pend',
  evaluating: 'chip chip-pend',
  verdict: 'chip chip-pend',
  awaiting_approval: 'chip chip-pend',
  settling: 'chip chip-pend',
  settled: 'chip chip-allow',
  rejected: 'chip chip-deny',
  denied: 'chip chip-deny',
  failed: 'chip chip-deny',
};

export function JobsList({ jobs }: { jobs: JobView[] }) {
  if (jobs.length === 0) {
    return (
      <div className="deadstate" data-testid="jobs-empty">
        <svg className="leash-svg" viewBox="0 0 80 44" aria-hidden="true">
          <circle className="leash-clasp" cx="10" cy="22" r="6" />
          <path className="leash-path" d="M16 22 Q 40 30 74 22" />
        </svg>
        <h4>No jobs yet</h4>
        <p>A requester agent posts one from its seeded job spec. Define a job to seed the first.</p>
      </div>
    );
  }
  return (
    <ul data-testid="jobs-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {jobs.map((job) => (
        <li key={job.jobId}>
          <Link
            href={`/jobs/${job.jobId}`}
            className="panel"
            data-testid={`job-row-${job.jobId}`}
            style={{ display: 'grid', gap: 'var(--s-3)', textDecoration: 'none', color: 'inherit' }}
          >
            <p className="p-title" style={{ margin: 0, textTransform: 'none', letterSpacing: 0, fontFamily: 'var(--font-sans)', fontSize: '0.95rem', color: 'var(--ink)' }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.spec.question}</span>
              <span style={{ display: 'flex', gap: '8px', alignItems: 'center', flex: 'none' }}>
                <span className="badge-pill mono tnum">{formatToken(job.feeAmountWei, job.feeTokenDecimals ?? 6)} {job.feeTokenSymbol ?? ''}</span>
                <span className={STATUS_CHIP[job.status]}>{job.status.replace(/_/g, ' ')}</span>
              </span>
            </p>
            {/* console.html jobBlock renders the stepper per row — at-a-glance lifecycle progress. */}
            <JobStepper job={job} />
          </Link>
        </li>
      ))}
    </ul>
  );
}
