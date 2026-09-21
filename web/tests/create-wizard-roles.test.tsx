// File: web/tests/create-wizard-roles.test.tsx
// Role variant chooser (spec §3c): sentinel gets the spend-incapable preset (zero caps,
// empty allowlist, no fund step, no topUp≤cap validation); executor drops the goal amount
// fields and ships {type:'executor'}; treasury stays byte-compatible. Plus the friendly
// create-guardrail error copy (429/403/400).
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CreateWizard, type WizardResult } from '@/components/create/CreateWizard';
import { ApiError } from '@/lib/api';

const PAYEE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

function okResult(): WizardResult {
  return {
    response: {
      agentId: 'agent-2',
      accountAddr: '0x0000000000000000000000000000000000000001',
      sessionKeyAddr: '0x0000000000000000000000000000000000000002',
      gatewayToken: 'tok_secret_once',
      txHashes: [],
    },
    kekMode: 'signature',
    downloadBackup: vi.fn(),
  };
}

type User = ReturnType<typeof userEvent.setup>;

async function startAndName(user: User) {
  await user.type(screen.getByLabelText('Agent name'), 'Second agent');
  await user.click(screen.getByTestId('wizard-next'));
}

describe('CreateWizard role chooser', () => {
  it('defaults to treasury with the Phase-1 goal fields visible', async () => {
    const user = userEvent.setup();
    render(<CreateWizard onCreate={vi.fn()} walletReady />);
    await startAndName(user);
    expect(screen.getByTestId('role-treasury')).toBeChecked();
    expect(screen.getByLabelText('Who to keep topped up')).toBeInTheDocument();
    expect(screen.getByLabelText('Send at most, per top-up')).toBeInTheDocument();
  });

  it('sentinel: zero-cap preset, empty allowlist, skips policy steps and the fund step', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(okResult());
    render(<CreateWizard onCreate={onCreate} walletReady />);
    await startAndName(user);

    await user.click(screen.getByTestId('role-sentinel'));
    await user.type(screen.getByLabelText('Who to keep topped up'), PAYEE);
    // topUp (0.01 default) EXCEEDS the zero cap by construction — sentinel must not block.
    await user.click(screen.getByTestId('wizard-next'));

    // Spend-incapable preset explainer replaces the three policy steps.
    expect(screen.getByTestId('sentinel-policy-note')).toHaveTextContent(/can only ask/i);
    expect(
      screen.getByRole('heading', { name: /can never move money/i }),
    ).toBeInTheDocument();
    await user.click(screen.getByTestId('wizard-next')); // → expiry
    await user.click(screen.getByTestId('wizard-next')); // → review

    expect(screen.getByTestId('review-summary')).toHaveTextContent('never pays');
    expect(screen.getByTestId('review-summary')).toHaveTextContent('nobody (empty allowlist)');
    expect(screen.queryByTestId('goal-cap-error')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('create-agent'));
    expect(await screen.findByTestId('create-done')).toBeInTheDocument();

    const input = onCreate.mock.calls[0]?.[0];
    expect(input.policy.perTransferCapWei).toBe('0');
    expect(input.policy.windowCapWei).toBe('0');
    expect(input.allowlist).toEqual([]);
    expect(input.goal).toEqual({
      type: 'sentinel',
      beneficiary: PAYEE,
      targetBalanceWei: '100000000000000000',
      topUpWei: '10000000000000000',
    });

    // No fund step for a spend-incapable agent — nothing to spend.
    expect(screen.queryByTestId('fund-section')).not.toBeInTheDocument();
    expect(screen.getByTestId('sentinel-no-fund-note')).toHaveTextContent(/nothing to fund/i);
  });

  it('executor: hides goal amount fields, keeps normal policy steps, sends {type:executor}', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(okResult());
    render(<CreateWizard onCreate={onCreate} walletReady />);
    await startAndName(user);

    await user.click(screen.getByTestId('role-executor'));
    expect(screen.queryByLabelText('Who to keep topped up')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Keep them at')).not.toBeInTheDocument();
    expect(screen.getByTestId('executor-goal-note')).toBeInTheDocument();

    await user.click(screen.getByTestId('wizard-next')); // → per-payment cap
    expect(screen.getByLabelText('Most it can send in one payment')).toBeInTheDocument();
    await user.click(screen.getByTestId('wizard-next')); // → budget
    await user.click(screen.getByTestId('wizard-next')); // → allowlist (NOT seeded)
    const payeeField = screen.getByLabelText('Allowed recipient');
    expect(payeeField).toHaveValue('');
    expect(screen.getByText(/bounds who this agent can pay/i)).toBeInTheDocument();
    await user.type(payeeField, PAYEE);
    await user.click(screen.getByTestId('wizard-next')); // → expiry
    await user.click(screen.getByTestId('wizard-next')); // → review

    expect(screen.getByTestId('review-summary')).toHaveTextContent('acts on requests');
    await user.click(screen.getByTestId('create-agent'));
    expect(await screen.findByTestId('create-done')).toBeInTheDocument();

    const input = onCreate.mock.calls[0]?.[0];
    expect(input.goal).toEqual({ type: 'executor' });
    expect(input.allowlist).toEqual([PAYEE]);
    expect(input.policy.perTransferCapWei).toBe('10000000000000000'); // 0.01 default
  });

  it('switching back to treasury restores the full step order and validations', async () => {
    const user = userEvent.setup();
    render(<CreateWizard onCreate={vi.fn()} walletReady />);
    await startAndName(user);
    await user.click(screen.getByTestId('role-sentinel'));
    await user.click(screen.getByTestId('role-treasury'));
    await user.type(screen.getByLabelText('Who to keep topped up'), PAYEE);
    await user.click(screen.getByTestId('wizard-next'));
    // Treasury path: next step is the per-payment cap, not the sentinel explainer.
    expect(screen.getByLabelText('Most it can send in one payment')).toBeInTheDocument();
  });
});

describe('CreateWizard create-guardrail errors', () => {
  async function toTreasuryCreate(user: User) {
    await startAndName(user);
    await user.type(screen.getByLabelText('Who to keep topped up'), PAYEE);
    await user.click(screen.getByTestId('wizard-next'));
    await user.click(screen.getByTestId('wizard-next'));
    await user.click(screen.getByTestId('wizard-next'));
    await user.click(screen.getByTestId('wizard-next'));
    await user.click(screen.getByTestId('wizard-next'));
    await user.click(screen.getByTestId('create-agent'));
  }

  it('429 rate_limited renders the retry seconds', async () => {
    const user = userEvent.setup();
    const onCreate = vi
      .fn()
      .mockRejectedValue(new ApiError(429, 'rate_limited', { error: 'rate_limited', retryAfter: 120 }));
    render(<CreateWizard onCreate={onCreate} walletReady />);
    await toTreasuryCreate(user);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/a bit fast/i);
    expect(alert).toHaveTextContent('120 seconds');
  });

  it('403 quota_exceeded renders the limit', async () => {
    const user = userEvent.setup();
    const onCreate = vi
      .fn()
      .mockRejectedValue(new ApiError(403, 'quota_exceeded', { error: 'quota_exceeded', limit: 10 }));
    render(<CreateWizard onCreate={onCreate} walletReady />);
    await toTreasuryCreate(user);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/limit of agents/i);
    expect(alert).toHaveTextContent('(10)');
  });

  it('400 allowlist_too_long renders the max', async () => {
    const user = userEvent.setup();
    const onCreate = vi
      .fn()
      .mockRejectedValue(new ApiError(400, 'allowlist_too_long', { error: 'allowlist_too_long', max: 16 }));
    render(<CreateWizard onCreate={onCreate} walletReady />);
    await toTreasuryCreate(user);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/too long/i);
    expect(alert).toHaveTextContent('at most 16 addresses');
  });
});
