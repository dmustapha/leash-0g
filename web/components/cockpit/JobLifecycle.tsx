// File: web/components/cockpit/JobLifecycle.tsx
// Phase-4 cockpit (spec §7, D-JOB-9): the full ACP job lifecycle on a real task
// — request → deliver → VERIFY → settle. The deliverable summary and the
// evaluator rationale are UNTRUSTED agent text (F-quar): rendered QUARANTINED
// (labeled "unverified", quoted, set apart), never mixed into the verified PoA
// fields (which hold only hashes/roots/sigs). The layered gate is shown
// explicitly so the owner sees WHY a settlement did or did not release.
'use client';

import type { JobView, JobStatus, ApprovalDecision } from '@/lib/types';
import { Disclosure } from '@/components/ui/Disclosure';
import { shortAddr } from '@/lib/format';

/** TestUSD is 6-dp; render base units as a decimal token amount. */
function formatToken(baseUnits: string, decimals = 6): string {
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

const STATUS_COPY: Record<JobStatus, { label: string; tone: 'idle' | 'accent' | 'allow' | 'deny' }> = {
  originated: { label: 'Requested', tone: 'idle' },
  delivered: { label: 'Delivered', tone: 'accent' },
  evaluating: { label: 'Evaluating', tone: 'accent' },
  verdict: { label: 'Verdict in', tone: 'accent' },
  awaiting_approval: { label: 'Awaiting your approval', tone: 'accent' },
  settled: { label: 'Settled', tone: 'allow' },
  rejected: { label: 'Rejected', tone: 'deny' },
  denied: { label: 'Denied', tone: 'deny' },
  failed: { label: 'Failed', tone: 'deny' },
};

function Quarantined({ label, text }: { label: string; text: string }) {
  return (
    <div
      data-testid="quarantined"
      style={{ borderLeft: '2px solid var(--color-line)', paddingLeft: '0.7rem', display: 'grid', gap: '0.15rem' }}
    >
      <span style={{ fontSize: '0.72rem', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--color-ink-faint)' }}>
        {label} · unverified
      </span>
      <span style={{ fontSize: '0.86rem', color: 'var(--color-ink-dim)', fontStyle: 'italic', whiteSpace: 'pre-wrap' }}>
        “{text}”
      </span>
    </div>
  );
}

function Stage({
  n,
  title,
  done,
  active,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  active: boolean;
  children?: React.ReactNode;
}) {
  return (
    <li data-testid={`job-stage-${n}`} style={{ display: 'grid', gap: '0.4rem', opacity: done || active ? 1 : 0.5 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <span className={`pill ${done ? 'pill-allow' : active ? 'pill-accent' : 'pill-idle'}`}>{n}</span>
        <strong style={{ fontSize: '0.92rem' }}>{title}</strong>
      </div>
      {children ? <div style={{ paddingLeft: '2rem', display: 'grid', gap: '0.5rem' }}>{children}</div> : null}
    </li>
  );
}

export function JobLifecycle({
  job,
  onDecide,
  tokenSymbol,
}: {
  job: JobView;
  /** Verdict-bound settlement approve/deny (rides the shared approvals rail). */
  onDecide?: (approvalId: string, decision: ApprovalDecision) => void;
  /** Fallback only — the job's own detected symbol/decimals win when present. */
  tokenSymbol?: string;
}) {
  // Detect the true settlement asset from the job (read on-chain at originate);
  // fall back to the prop / generic only when metadata is absent.
  const sym = job.feeTokenSymbol ?? tokenSymbol ?? 'tokens';
  const dec = job.feeTokenDecimals ?? 6;
  const fee = (base: string) => formatToken(base, dec);
  const status = STATUS_COPY[job.status];
  const delivered = job.deliverableRoot !== null;
  const verdictIn = job.verdict !== null;
  const settled = job.status === 'settled';
  const blockedAcceptance = job.blockedBy === 'acceptance';
  const blockedVerdict = job.blockedBy === 'verdict';

  return (
    <section className="panel" data-testid="job-lifecycle" style={{ display: 'grid', gap: '1rem' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
        <div style={{ display: 'grid', gap: '0.2rem' }}>
          <span style={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-ink-faint)' }}>
            ACP job
          </span>
          <strong style={{ fontSize: '1rem' }}>{job.spec.question}</strong>
        </div>
        <span className={`pill pill-${status.tone}`} data-testid="job-status">
          {status.label}
        </span>
      </header>

      <ol style={{ display: 'grid', gap: '1rem', listStyle: 'none', margin: 0, padding: 0 }}>
        {/* 1 — request */}
        <Stage n={1} title="Requested" done active={false}>
          <p style={{ margin: 0, fontSize: '0.86rem', color: 'var(--color-ink-dim)' }}>
            Fee if accepted: <strong>{fee(job.feeAmountWei)} {sym}</strong> to {shortAddr(job.feeRecipient)}.
            The amount comes from your seeded job spec — never from the agents.
          </p>
        </Stage>

        {/* 2 — deliver */}
        <Stage n={2} title="Delivered on 0G Storage" done={delivered} active={job.status === 'delivered'}>
          {delivered ? (
            <>
              {job.deliverableSummary ? <Quarantined label="Provider says" text={job.deliverableSummary} /> : null}
              <Disclosure label="Deliverable (untrusted — for review only)">
                <pre className="code" style={{ whiteSpace: 'pre-wrap', fontSize: '0.78rem' }}>
                  {JSON.stringify(job.deliverable, null, 2)}
                </pre>
              </Disclosure>
              {job.deliverableRoot ? (
                <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--color-ink-faint)' }}>
                  0G Storage root: <code className="code">{job.deliverableRoot}</code> — owner-only encrypted; verify
                  integrity without decrypt from the audit tab.
                </p>
              ) : null}
            </>
          ) : (
            <p style={{ margin: 0, fontSize: '0.86rem', color: 'var(--color-ink-faint)' }}>Waiting for the provider…</p>
          )}
        </Stage>

        {/* 3 — verify (the layered gate) */}
        <Stage n={3} title="Verified — the layered gate" done={verdictIn && !blockedAcceptance} active={job.status === 'evaluating'}>
          {/* layer 1: deterministic acceptance floor */}
          {job.acceptance ? (
            <p style={{ margin: 0, fontSize: '0.86rem', color: job.acceptance.passed ? 'var(--color-ink-dim)' : 'var(--color-deny, #d66)' }} data-testid="acceptance-result">
              <strong>Floor (automatic):</strong>{' '}
              {job.acceptance.passed
                ? `passed ${job.acceptance.checked} structural checks`
                : `blocked — ${job.acceptance.failures.join('; ')}`}
            </p>
          ) : null}
          {/* layer 2: skeptic evaluator verdict */}
          {verdictIn ? (
            <div style={{ display: 'grid', gap: '0.35rem' }} data-testid="verdict-block">
              <p style={{ margin: 0, fontSize: '0.86rem' }}>
                <strong>Evaluator (skeptic):</strong>{' '}
                <span className={`pill ${job.verdict === 'accept' ? 'pill-allow' : 'pill-deny'}`}>{job.verdict}</span>
              </p>
              {job.rationaleRef ? (
                <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--color-ink-faint)' }}>
                  Rationale on 0G Storage: <code className="code">{job.rationaleRef}</code> (untrusted agent text)
                </p>
              ) : null}
            </div>
          ) : (
            <p style={{ margin: 0, fontSize: '0.86rem', color: 'var(--color-ink-faint)' }}>
              {blockedAcceptance ? 'Never evaluated — the floor blocked it.' : 'Waiting for the evaluator…'}
            </p>
          )}
        </Stage>

        {/* 4 — settle (owner-supervised, verdict-bound) */}
        <Stage n={4} title="Settled — governed on-chain fee" done={settled} active={job.status === 'awaiting_approval'}>
          {job.status === 'awaiting_approval' && job.approvalId ? (
            <div style={{ display: 'grid', gap: '0.5rem' }} data-testid="settlement-approval">
              <p style={{ margin: 0, fontSize: '0.86rem', color: 'var(--color-ink-dim)' }}>
                Release <strong>{fee(job.feeAmountWei)} {sym}</strong> to {shortAddr(job.feeRecipient)}?
                The deliverable passed the floor and the evaluator accepted it — the final call is yours.
              </p>
              {onDecide ? (
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button
                    className="btn btn-primary btn-sm"
                    data-testid="job-approve"
                    onClick={() => onDecide(job.approvalId as string, { decision: 'approve' })}
                  >
                    Approve settlement
                  </button>
                  <button
                    className="btn btn-danger btn-sm"
                    data-testid="job-deny"
                    onClick={() => onDecide(job.approvalId as string, { decision: 'deny' })}
                  >
                    Deny
                  </button>
                </div>
              ) : null}
            </div>
          ) : settled && job.settlementTx ? (
            <p style={{ margin: 0, fontSize: '0.86rem', color: 'var(--color-ink-dim)' }} data-testid="settlement-tx">
              Paid <strong>{fee(job.feeAmountWei)} {sym}</strong> — tx{' '}
              <code className="code">{shortAddr(job.settlementTx)}</code>
            </p>
          ) : blockedVerdict || job.status === 'rejected' || job.status === 'denied' ? (
            <p style={{ margin: 0, fontSize: '0.86rem', color: 'var(--color-ink-faint)' }} data-testid="no-settlement">
              No payment — {job.blockedBy === 'owner' || job.status === 'denied' ? 'you denied it' : job.blockedBy === 'verdict' ? 'the evaluator rejected the work' : 'the work did not pass the floor'}.
            </p>
          ) : (
            <p style={{ margin: 0, fontSize: '0.86rem', color: 'var(--color-ink-faint)' }}>Not yet due.</p>
          )}
        </Stage>
      </ol>

      {/* Proof-of-Agreement — the verified, multi-party signed record (F7) */}
      {job.poa ? (
        <Disclosure label="Proof of Agreement (each party signed its own step)">
          <div className="code" style={{ display: 'grid', gap: '0.25rem', fontSize: '0.76rem', whiteSpace: 'pre-wrap' }} data-testid="poa">
            <span>requester signed job spec: {shortAddr(job.poa.requesterSig)}</span>
            <span>provider signed deliverable: {shortAddr(job.poa.providerSig)}</span>
            <span>evaluator signed verdict ({job.poa.verdict}): {shortAddr(job.poa.evaluatorSig)}</span>
            {job.poa.settlementTx ? <span>settlement tx: {shortAddr(job.poa.settlementTx)}</span> : null}
          </div>
        </Disclosure>
      ) : null}
    </section>
  );
}
