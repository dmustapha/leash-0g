// File: web/tests/create-wizard-phase5.test.tsx
// Phase-5 Stage A: requester demotion (D-A1) + job-spec picker (D-A2) + prefill→review (D-B3).
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CreateWizard, type WizardPrefill, type WizardResult } from '@/components/create/CreateWizard';
import type { JobSpecSummary } from '@/lib/types';

const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

function okResult(): WizardResult {
  return {
    response: { agentId: 'a1', accountAddr: '0x0000000000000000000000000000000000000001', sessionKeyAddr: '0x0000000000000000000000000000000000000002', gatewayToken: 't', txHashes: [] },
    kekMode: 'signature',
    downloadBackup: vi.fn(),
  };
}

const SPECS: JobSpecSummary[] = [{ ref: 'eth-4000', label: 'ETH price', questionPreview: 'where is ETH heading' }];
const FULL_AGENTS = { providers: [{ id: 'p1', name: 'P' }], evaluators: [{ id: 'e1', name: 'E' }] };

async function toGoalStep(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Agent name'), 'X');
  await user.click(screen.getByTestId('wizard-next'));
}

describe('CreateWizard — requester demotion (D-A1)', () => {
  it('requester is NOT a peer role on the first-run surface', async () => {
    const user = userEvent.setup();
    render(<CreateWizard onCreate={vi.fn()} walletReady />);
    await toGoalStep(user);
    // The five single-agent roles are present; the requester is behind the advanced door.
    expect(screen.getByTestId('role-treasury')).toBeInTheDocument();
    expect(screen.queryByTestId('role-requester')).not.toBeInTheDocument();
    expect(screen.getByTestId('advanced-toggle')).toBeInTheDocument();
  });

  it('none: advanced door shows the explainer + CTA, requester disabled', async () => {
    const user = userEvent.setup();
    const onStartAgent = vi.fn();
    render(<CreateWizard onCreate={vi.fn()} walletReady onStartAgent={onStartAgent} />);
    await toGoalStep(user);
    await user.click(screen.getByTestId('advanced-toggle'));
    expect(screen.getByTestId('requester-locked')).toHaveTextContent(/first create a worker and a judge/i);
    expect(screen.queryByTestId('role-requester')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('requester-cta'));
    expect(onStartAgent).toHaveBeenCalled();
  });

  it('partial (provider+evaluator but no job spec): still locked', async () => {
    const user = userEvent.setup();
    render(<CreateWizard onCreate={vi.fn()} walletReady jobAgents={FULL_AGENTS} jobSpecs={[]} />);
    await toGoalStep(user);
    await user.click(screen.getByTestId('advanced-toggle'));
    expect(screen.getByTestId('requester-locked')).toBeInTheDocument();
    expect(screen.queryByTestId('role-requester')).not.toBeInTheDocument();
  });

  it('all present: requester is unlocked in the advanced door', async () => {
    const user = userEvent.setup();
    render(<CreateWizard onCreate={vi.fn()} walletReady jobAgents={FULL_AGENTS} jobSpecs={SPECS} />);
    await toGoalStep(user);
    await user.click(screen.getByTestId('advanced-toggle'));
    expect(screen.getByTestId('role-requester')).toBeInTheDocument();
    expect(screen.queryByTestId('requester-locked')).not.toBeInTheDocument();
  });
});

describe('CreateWizard — job-spec picker (D-A2)', () => {
  it('the job handle is a PICKER over saved specs, not free text', async () => {
    const user = userEvent.setup();
    render(<CreateWizard onCreate={vi.fn()} walletReady jobAgents={FULL_AGENTS} jobSpecs={SPECS} />);
    await toGoalStep(user);
    await user.click(screen.getByTestId('advanced-toggle'));
    await user.click(screen.getByTestId('role-requester'));
    await user.click(screen.getByTestId('wizard-next')); // → requester-config
    const picker = screen.getByTestId('requester-jobspec');
    expect(picker.tagName).toBe('SELECT');
    await user.selectOptions(picker, 'eth-4000');
    expect((picker as HTMLSelectElement).value).toBe('eth-4000');
  });

  it('an INCOMPLETE requester prefill drops on requester-config (guided), NOT a stranded review (D-A5)', () => {
    // A requester's settlement-token address + picks + job handle are never guessed
    // (never-guess-money), so its prefill is legitimately incomplete. It must land on the
    // config step to be finished — not on a review with a disabled Create button.
    const prefill: WizardPrefill = {
      name: 'R',
      policy: { perTransferCapWei: '0', windowCapWei: '0', windowSeconds: 86400, expiresAt: Math.floor(Date.now() / 1000) + 999999 },
      allowlist: [RECIPIENT],
      goal: { type: 'requester', jobSpecSource: '', providerAgentId: '', evaluatorAgentId: '', feeToken: '' as `0x${string}`, feeRecipient: RECIPIENT, feeCapPerJobWei: '' },
    };
    render(<CreateWizard onCreate={vi.fn()} walletReady jobAgents={FULL_AGENTS} jobSpecs={SPECS} prefill={prefill} />);
    // Guided to the requester config step, not stranded on review.
    expect(screen.queryByTestId('review-summary')).not.toBeInTheDocument();
    expect(screen.getByTestId('requester-provider')).toBeInTheDocument();
  });
});

describe('CreateWizard — prefill jumps to review (D-B3)', () => {
  it('a provider prefill seeds review and creates with the seeded goal + capabilityLabel', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(okResult());
    const prefill: WizardPrefill = {
      name: 'Forecaster',
      policy: { perTransferCapWei: '0', windowCapWei: '0', windowSeconds: 86400, expiresAt: Math.floor(Date.now() / 1000) + 999999 },
      allowlist: [],
      goal: { type: 'provider', serviceSpec: 'calibrated odds' },
      capabilityLabel: 'market forecaster',
    };
    render(<CreateWizard onCreate={onCreate} walletReady prefill={prefill} />);
    // Screen 2 of the happy path: straight to review.
    expect(screen.getByTestId('review-summary')).toBeInTheDocument();
    expect(screen.getByTestId('review-summary')).toHaveTextContent('market forecaster');
    await user.click(screen.getByTestId('create-agent'));
    expect(await screen.findByTestId('create-done')).toBeInTheDocument();
    const input = onCreate.mock.calls[0]![0];
    expect(input.goal).toEqual({ type: 'provider', serviceSpec: 'calibrated odds' });
    expect(input.capabilityLabel).toBe('market forecaster');
  });
});
