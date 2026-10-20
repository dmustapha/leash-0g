// File: web/components/cockpit/JobStepper.tsx
// The console.html jobs stepper (console.html:1140-1148), extracted so the compact jobs LIST
// row and the full lifecycle view render the SAME per-row progress indicator. The six display
// steps ARE the real JobStatus progression verbatim — no fabrication — and terminal statuses
// fail at the step where the job actually died (reconciled from the real blockedBy/progress
// markers, see failIndex).
'use client';

import type { JobView, JobStatus } from '@/lib/types';

export const JOB_STEPS: JobStatus[] = ['originated', 'delivered', 'evaluating', 'verdict', 'awaiting_approval', 'settled'];

export function failIndex(job: JobView): number {
  if (job.status === 'denied' || job.blockedBy === 'owner') return JOB_STEPS.indexOf('awaiting_approval');
  if (job.status === 'rejected' || job.blockedBy === 'verdict') return JOB_STEPS.indexOf('verdict');
  if (job.blockedBy === 'acceptance') return JOB_STEPS.indexOf('evaluating');
  // A generic 'failed' with no blockedBy reason: infer how far it actually got from the real
  // progress markers rather than guessing — a verdict means it died at/after evaluation, a
  // deliverable-but-no-verdict means it died in evaluation, neither means it died at delivery.
  if (job.verdict !== null) return JOB_STEPS.indexOf('verdict');
  if (job.deliverableRoot !== null) return JOB_STEPS.indexOf('evaluating');
  return JOB_STEPS.indexOf('delivered');
}

export function JobStepper({ job }: { job: JobView }) {
  const term = job.status === 'rejected' || job.status === 'denied' || job.status === 'failed';
  // 'settling' is a broadcast-but-unconfirmed fee transfer — show 'settled' as the active step.
  const current = job.status === 'settling' ? 'settled' : job.status;
  const idx = term ? failIndex(job) : JOB_STEPS.indexOf(current);
  return (
    <div className="stepper" data-testid="job-stepper">
      {JOB_STEPS.map((s, i) => {
        const st = i < idx ? 'done' : i === idx ? (term ? 'fail' : 'active') : '';
        const label = term && s === JOB_STEPS[idx] ? job.status : s;
        // console.html renders .step and .sbar as DIRECT siblings of .stepper (not wrapped) —
        // the flex row interleaves circles and connector bars. A Fragment keeps that structure.
        return (
          <JobStepperCell key={s} st={st} label={label} isLast={i === JOB_STEPS.length - 1} barDone={i < idx} />
        );
      })}
    </div>
  );
}

function JobStepperCell({ st, label, isLast, barDone }: { st: string; label: string; isLast: boolean; barDone: boolean }) {
  return (
    <>
      <div className={`step ${st}`}>
        <div className="sc">
          <div className="sd" />
          <div className="sl">{label.replace(/_/g, ' ')}</div>
        </div>
      </div>
      {!isLast ? <div className={`sbar ${barDone ? 'done' : ''}`} /> : null}
    </>
  );
}

/** TestUSD is 6-dp; render base units as a decimal token amount (shared by the list row + detail). */
export function formatToken(baseUnits: string, decimals = 6): string {
  try {
    const v = BigInt(baseUnits);
    const d = 10n ** BigInt(decimals);
    const whole = v / d;
    const frac = (v % d).toString().padStart(decimals, '0').replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : `${whole}`;
  } catch {
    return baseUnits;
  }
}
