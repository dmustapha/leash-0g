// File: web/tests/job-lifecycle.test.tsx
// Phase-4 cockpit parity (spec §7, D-JOB-9): the job lifecycle view shows all
// four ACP stages, QUARANTINES the untrusted deliverable + rationale, surfaces
// the layered gate, and exposes the verdict-bound settlement approve/deny.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { JobLifecycle } from '@/components/cockpit/JobLifecycle';
import type { JobView } from '@/lib/types';

const BASE: JobView = {
  jobId: 'job-1',
  status: 'awaiting_approval',
  spec: { question: 'Will ETH close above $4000 this month?', deliverableSchemaRef: 's', acceptanceRef: 'a' },
  jobSpecHash: `0x${'11'.repeat(32)}`,
  requesterAgentId: 'req',
  providerAgentId: 'prov',
  evaluatorAgentId: 'evalr',
  feeToken: `0x${'77'.repeat(20)}`,
  feeAmountWei: '5000000', // 5.0 TestUSD (6dp)
  feeRecipient: `0x${'9c'.repeat(20)}`,
  feeTokenSymbol: 'TestUSD',
  feeTokenDecimals: 6,
  deliverable: { probability: 0.62, rationale: 'grounded' },
  deliverableRoot: `0x${'ab'.repeat(32)}`,
  deliverableSummary: 'calibrated 0.62 with cited signals',
  acceptance: { passed: true, failures: [], checked: 4 },
  verdict: 'accept',
  rationaleRef: `0x${'cd'.repeat(32)}`,
  approvalId: 'apr-9',
  settlementTx: null,
  settlementTxPending: null,
  poa: null,
  blockedBy: null,
  createdAt: '2026-09-22T00:00:00Z',
  updatedAt: '2026-09-22T00:00:00Z',
};

describe('JobLifecycle', () => {
  it('renders the question, the fee in token units, and the awaiting-approval status', () => {
    render(<JobLifecycle job={BASE} onDecide={vi.fn()} />);
    expect(screen.getByText(BASE.spec.question)).toBeInTheDocument();
    expect(screen.getByTestId('job-status')).toHaveTextContent(/awaiting your approval/i);
    expect(screen.getAllByText(/5 TestUSD/).length).toBeGreaterThan(0);
  });

  it('QUARANTINES the untrusted provider summary (labeled unverified, quoted)', () => {
    render(<JobLifecycle job={BASE} onDecide={vi.fn()} />);
    const q = screen.getAllByTestId('quarantined')[0];
    expect(q).toHaveTextContent(/unverified/i);
    expect(q).toHaveTextContent('calibrated 0.62 with cited signals');
  });

  it('shows the layered gate: floor passed + evaluator accept', () => {
    render(<JobLifecycle job={BASE} onDecide={vi.fn()} />);
    expect(screen.getByTestId('acceptance-result')).toHaveTextContent(/passed 4 structural checks/i);
    expect(screen.getByTestId('verdict-block')).toHaveTextContent(/accept/i);
  });

  it('exposes verdict-bound approve/deny and wires the shared approvals rail', async () => {
    const onDecide = vi.fn();
    render(<JobLifecycle job={BASE} onDecide={onDecide} />);
    await userEvent.click(screen.getByTestId('job-approve'));
    expect(onDecide).toHaveBeenCalledWith('apr-9', { decision: 'approve' });
  });

  it('acceptance-floor block: no evaluation, no settlement (layer 1)', () => {
    const blocked: JobView = {
      ...BASE,
      status: 'rejected',
      acceptance: { passed: false, failures: ['field "probability" (9.9) above max 1'], checked: 4 },
      verdict: null,
      deliverableSummary: null,
      approvalId: null,
      blockedBy: 'acceptance',
    };
    render(<JobLifecycle job={blocked} onDecide={vi.fn()} />);
    expect(screen.getByTestId('acceptance-result')).toHaveTextContent(/blocked/i);
    expect(screen.getByTestId('no-settlement')).toHaveTextContent(/did not pass the floor/i);
    expect(screen.queryByTestId('settlement-approval')).toBeNull();
  });

  it('settled: shows the governed on-chain fee tx', () => {
    const settled: JobView = { ...BASE, status: 'settled', approvalId: null, settlementTx: `0x${'dd'.repeat(32)}` };
    render(<JobLifecycle job={settled} onDecide={vi.fn()} />);
    expect(screen.getByTestId('settlement-tx')).toHaveTextContent(/Paid/i);
  });

  it('renders the multi-party PoA when present (each party signed its step)', () => {
    const withPoa: JobView = {
      ...BASE,
      status: 'settled',
      settlementTx: `0x${'dd'.repeat(32)}`,
      approvalId: null,
      poa: {
        jobId: 'job-1',
        jobSpecHash: BASE.jobSpecHash,
        requesterSig: `0x${'a1'.repeat(32)}`,
        deliverableRoot: BASE.deliverableRoot as string,
        providerSig: `0x${'b2'.repeat(32)}`,
        verdict: 'accept',
        evaluatorSig: `0x${'c3'.repeat(32)}`,
        acceptance: { passed: true, checked: 4, failureCount: 0 },
        settlementTx: `0x${'dd'.repeat(32)}`,
      },
    };
    render(<JobLifecycle job={withPoa} onDecide={vi.fn()} />);
    // G-2.3b: the PoA renders as console.html's key/value grid — each party's signature
    // keyed by its field name (requesterSig / evaluatorSig), the verdict as a chip.
    const poa = screen.getByTestId('poa');
    expect(poa).toHaveTextContent('requesterSig');
    expect(poa).toHaveTextContent('evaluatorSig');
    expect(poa).toHaveTextContent('jobSpecHash');
    expect(poa).toHaveTextContent('verdict');
  });
});

// G-2.3b: the console.html progress stepper. Its step classes are driven purely by the real
// JobStatus (no invented stages) — so these cases pin the status→step mapping, including the
// settling remap and the data-driven terminal fail-dot placement (Gate-② W1/W2).
describe('JobStepper (G-2.3b)', () => {
  // The .step whose visible label matches `label` (labels render with _ → space).
  function stepClass(container: HTMLElement, label: string): string {
    const stepper = container.querySelector('[data-testid="job-stepper"]')!;
    const steps = [...stepper.querySelectorAll('.step')];
    const hit = steps.find((s) => s.querySelector('.sl')?.textContent?.trim() === label);
    if (!hit) throw new Error(`no step labeled "${label}" (have: ${steps.map((s) => s.querySelector('.sl')?.textContent).join(', ')})`);
    return hit.className;
  }

  it('awaiting_approval: that step is active, earlier steps done, settled still pending', () => {
    const { container } = render(<JobLifecycle job={{ ...BASE, status: 'awaiting_approval' }} onDecide={vi.fn()} />);
    expect(stepClass(container, 'awaiting approval')).toContain('active');
    expect(stepClass(container, 'originated')).toContain('done');
    expect(stepClass(container, 'verdict')).toContain('done');
    expect(stepClass(container, 'settled')).not.toMatch(/done|active|fail/);
  });

  it('settling: remapped to the settled step shown active (never a crash, never a blank)', () => {
    const { container } = render(<JobLifecycle job={{ ...BASE, status: 'settling' }} onDecide={vi.fn()} />);
    expect(stepClass(container, 'settled')).toContain('active');
    expect(stepClass(container, 'awaiting approval')).toContain('done');
  });

  it('rejected: fail dot at the verdict step, labeled with the terminal status', () => {
    const { container } = render(<JobLifecycle job={{ ...BASE, status: 'rejected', verdict: 'reject' }} onDecide={vi.fn()} />);
    expect(stepClass(container, 'rejected')).toContain('fail'); // the verdict step relabels to 'rejected'
    expect(stepClass(container, 'evaluating')).toContain('done');
  });

  it('denied: owner call → fail dot at awaiting_approval, not verdict', () => {
    const { container } = render(<JobLifecycle job={{ ...BASE, status: 'denied', blockedBy: 'owner' }} onDecide={vi.fn()} />);
    expect(stepClass(container, 'denied')).toContain('fail'); // awaiting_approval step relabels to 'denied'
    expect(stepClass(container, 'verdict')).toContain('done');
  });

  it('failed with a deliverable but no verdict: fail dot inferred at evaluating', () => {
    const { container } = render(
      <JobLifecycle job={{ ...BASE, status: 'failed', blockedBy: null, verdict: null, deliverableRoot: `0x${'ab'.repeat(32)}` }} onDecide={vi.fn()} />,
    );
    expect(stepClass(container, 'failed')).toContain('fail'); // evaluating step relabels to 'failed'
    expect(stepClass(container, 'delivered')).toContain('done');
  });
});
