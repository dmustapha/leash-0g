// File: web/tests/create-wizard.test.tsx
// Create-flow validation: step gating, invalid inputs, review summary, passphrase fallback.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  CreateWizard,
  PassphraseRequiredError,
  type WizardResult,
} from '@/components/create/CreateWizard';

const PAYEE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const OTHER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

function okResult(): WizardResult {
  return {
    response: {
      agentId: 'agent-1',
      accountAddr: '0x0000000000000000000000000000000000000001',
      sessionKeyAddr: '0x0000000000000000000000000000000000000002',
      gatewayToken: 'tok_secret_once',
      txHashes: [],
    },
    kekMode: 'signature',
    downloadBackup: vi.fn(),
  };
}

async function fillToReview(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Agent name'), 'Treasury helper');
  await user.click(screen.getByTestId('wizard-next'));
  await user.type(screen.getByLabelText('Who to keep topped up'), PAYEE);
  await user.click(screen.getByTestId('wizard-next')); // goal amounts default 0.1 / 0.01
  await user.click(screen.getByTestId('wizard-next')); // per-transfer default 0.01
  await user.click(screen.getByTestId('wizard-next')); // budget defaults
  // allowlist is pre-seeded with the beneficiary
  expect(screen.getByLabelText('Allowed recipient')).toHaveValue(PAYEE);
  await user.click(screen.getByTestId('wizard-next'));
  await user.click(screen.getByTestId('wizard-next')); // expiry default 7 days
}

describe('CreateWizard', () => {
  it('blocks an empty name', async () => {
    const user = userEvent.setup();
    render(<CreateWizard onCreate={vi.fn()} walletReady />);
    await user.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/name/i);
    expect(screen.getByLabelText('Agent name')).toBeInTheDocument(); // still on step 1
  });

  it('rejects an invalid beneficiary on the goal step', async () => {
    const user = userEvent.setup();
    render(<CreateWizard onCreate={vi.fn()} walletReady />);
    await user.type(screen.getByLabelText('Agent name'), 'A');
    await user.click(screen.getByTestId('wizard-next'));
    await user.type(screen.getByLabelText('Who to keep topped up'), '0xnot-an-address');
    await user.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/valid wallet address/i);
    expect(screen.getByLabelText('Who to keep topped up')).toBeInTheDocument(); // still on goal
  });

  it('seeds the allowlist with the beneficiary', async () => {
    const user = userEvent.setup();
    render(<CreateWizard onCreate={vi.fn()} walletReady />);
    await user.type(screen.getByLabelText('Agent name'), 'A');
    await user.click(screen.getByTestId('wizard-next'));
    await user.type(screen.getByLabelText('Who to keep topped up'), OTHER);
    await user.click(screen.getByTestId('wizard-next'));
    await user.click(screen.getByTestId('wizard-next')); // per-transfer
    await user.click(screen.getByTestId('wizard-next')); // budget
    expect(screen.getByLabelText('Allowed recipient')).toHaveValue(OTHER);
  });

  it('blocks create when a top-up exceeds the per-payment cap', async () => {
    const user = userEvent.setup();
    render(<CreateWizard onCreate={vi.fn()} walletReady />);
    await user.type(screen.getByLabelText('Agent name'), 'A');
    await user.click(screen.getByTestId('wizard-next'));
    await user.type(screen.getByLabelText('Who to keep topped up'), PAYEE);
    const topUp = screen.getByLabelText('Send at most, per top-up');
    await user.clear(topUp);
    await user.type(topUp, '0.05'); // per-payment cap stays at its 0.01 default
    await user.click(screen.getByTestId('wizard-next'));
    await user.click(screen.getByTestId('wizard-next')); // per-transfer
    await user.click(screen.getByTestId('wizard-next')); // budget
    await user.click(screen.getByTestId('wizard-next')); // allowlist (seeded)
    await user.click(screen.getByTestId('wizard-next')); // expiry
    expect(screen.getByTestId('goal-cap-error')).toHaveTextContent(/per-payment limit/i);
    expect(screen.getByTestId('create-agent')).toBeDisabled();
  });

  it('rejects an invalid per-transfer amount', async () => {
    const user = userEvent.setup();
    render(<CreateWizard onCreate={vi.fn()} walletReady />);
    await user.type(screen.getByLabelText('Agent name'), 'A');
    await user.click(screen.getByTestId('wizard-next'));
    await user.type(screen.getByLabelText('Who to keep topped up'), PAYEE);
    await user.click(screen.getByTestId('wizard-next'));
    const cap = screen.getByLabelText('Most it can send in one payment');
    await user.clear(cap);
    await user.type(cap, 'not-a-number');
    await user.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/greater than zero/i);
  });

  it('rejects an invalid allowlist address', async () => {
    const user = userEvent.setup();
    render(<CreateWizard onCreate={vi.fn()} walletReady />);
    await user.type(screen.getByLabelText('Agent name'), 'A');
    await user.click(screen.getByTestId('wizard-next'));
    await user.type(screen.getByLabelText('Who to keep topped up'), PAYEE);
    await user.click(screen.getByTestId('wizard-next'));
    await user.click(screen.getByTestId('wizard-next'));
    await user.click(screen.getByTestId('wizard-next'));
    const payee = screen.getByLabelText('Allowed recipient');
    await user.clear(payee); // drop the seeded beneficiary
    await user.type(payee, '0x1234');
    await user.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/valid wallet address/i);
  });

  it('walks to review, creates, and shows the one-time gateway token', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(okResult());
    render(<CreateWizard onCreate={onCreate} walletReady />);
    await fillToReview(user);
    expect(screen.getByTestId('review-summary')).toHaveTextContent('Treasury helper');
    expect(screen.getByTestId('review-summary')).toHaveTextContent('0.01 0G max');
    await user.click(screen.getByTestId('create-agent'));
    expect(await screen.findByTestId('gateway-token')).toHaveTextContent('tok_secret_once');
    expect(onCreate).toHaveBeenCalledOnce();
    const input = onCreate.mock.calls[0]?.[0];
    expect(input.allowlist).toEqual([PAYEE]);
    expect(input.policy.windowSeconds).toBe(24 * 3600);
    expect(input.goal).toEqual({
      beneficiary: PAYEE,
      targetBalanceWei: '100000000000000000', // 0.1 0G default
      topUpWei: '10000000000000000', // 0.01 0G default
    });
  });

  it('backstop: a PassphraseRequiredError from onCreate still routes to the loud degradation step', async () => {
    const user = userEvent.setup();
    const onCreate = vi
      .fn()
      .mockRejectedValueOnce(new PassphraseRequiredError())
      .mockResolvedValueOnce({ ...okResult(), kekMode: 'passphrase' });
    render(<CreateWizard onCreate={onCreate} walletReady />);
    await fillToReview(user);
    await user.click(screen.getByTestId('create-agent'));
    // the degradation step is LOUD: an alert stating nothing has been created
    expect(await screen.findByTestId('signing-degraded')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/nothing has been created/i);
    const pass = screen.getByLabelText('Passphrase');
    await user.type(pass, 'correct horse battery');
    await user.click(screen.getByTestId('confirm-passphrase-lock'));
    expect(await screen.findByTestId('create-done')).toBeInTheDocument();
    expect(onCreate).toHaveBeenLastCalledWith(expect.anything(), 'correct horse battery');
  });

  // G-10 (B-4 de-silencing): the signing degradation is surfaced PRE-commitment —
  // checkSigning resolves the lock mode before onCreate can fire, a degradation stops
  // the flow for explicit confirmation, and the create call never precedes that confirm.
  describe('G-10 pre-commitment signing check', () => {
    it('resolves the lock mode BEFORE the create call and proceeds on a healthy wallet', async () => {
      const user = userEvent.setup();
      const calls: string[] = [];
      const checkSigning = vi.fn(async () => {
        calls.push('check');
        return 'signature' as const;
      });
      const onCreate = vi.fn(async () => {
        calls.push('create');
        return okResult();
      });
      render(<CreateWizard onCreate={onCreate} checkSigning={checkSigning} walletReady />);
      await fillToReview(user);
      await user.click(screen.getByTestId('create-agent'));
      expect(await screen.findByTestId('create-done')).toBeInTheDocument();
      expect(calls).toEqual(['check', 'create']); // the check strictly precedes commitment
      expect(onCreate).toHaveBeenCalledWith(expect.anything(), undefined);
    });

    it('a degraded wallet STOPS the flow — no create until the owner confirms the passphrase downgrade', async () => {
      const user = userEvent.setup();
      const checkSigning = vi.fn(async () => 'passphrase' as const);
      const onCreate = vi.fn(async (_i: unknown, pass?: string) => ({
        ...okResult(),
        kekMode: (pass ? 'passphrase' : 'signature') as 'passphrase' | 'signature',
      }));
      render(<CreateWizard onCreate={onCreate} checkSigning={checkSigning} walletReady />);
      await fillToReview(user);
      await user.click(screen.getByTestId('create-agent'));
      // loud stop, pre-commitment: the create call has NOT fired
      expect(await screen.findByTestId('signing-degraded')).toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent(/nothing has been created/i);
      expect(onCreate).not.toHaveBeenCalled();
      // explicit confirm is required — then, and only then, the create fires
      await user.type(screen.getByLabelText('Passphrase'), 'correct horse battery');
      await user.click(screen.getByTestId('confirm-passphrase-lock'));
      expect(await screen.findByTestId('create-done')).toBeInTheDocument();
      expect(onCreate).toHaveBeenCalledOnce();
      expect(onCreate).toHaveBeenCalledWith(expect.anything(), 'correct horse battery');
    });

    it('the degraded step can retry wallet signing (forced re-probe) and create signature-locked', async () => {
      const user = userEvent.setup();
      const checkSigning = vi
        .fn()
        .mockResolvedValueOnce('passphrase')
        .mockResolvedValueOnce('signature');
      const onCreate = vi.fn(async () => okResult());
      render(<CreateWizard onCreate={onCreate} checkSigning={checkSigning} walletReady />);
      await fillToReview(user);
      await user.click(screen.getByTestId('create-agent'));
      expect(await screen.findByTestId('signing-degraded')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /try wallet signing again/i }));
      expect(await screen.findByTestId('create-done')).toBeInTheDocument();
      expect(checkSigning).toHaveBeenLastCalledWith({ force: true });
      expect(onCreate).toHaveBeenCalledWith(expect.anything(), undefined);
    });

    it('the degraded step can back out to review with nothing created', async () => {
      const user = userEvent.setup();
      const checkSigning = vi.fn(async () => 'passphrase' as const);
      const onCreate = vi.fn();
      render(<CreateWizard onCreate={onCreate} checkSigning={checkSigning} walletReady />);
      await fillToReview(user);
      await user.click(screen.getByTestId('create-agent'));
      expect(await screen.findByTestId('signing-degraded')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /back to review/i }));
      expect(await screen.findByTestId('review-summary')).toBeInTheDocument();
      expect(onCreate).not.toHaveBeenCalled();
    });

    it('a known-degraded wallet gets the honest passphrase story in the review disclosure', async () => {
      const user = userEvent.setup();
      render(
        <CreateWizard
          onCreate={vi.fn()}
          checkSigning={vi.fn(async () => 'passphrase' as const)}
          signingDegraded
          walletReady
        />,
      );
      await fillToReview(user);
      // native <details> content is in the DOM collapsed — query it directly
      expect(screen.getByText(/could not produce a stable signature/i)).toBeInTheDocument();
      expect(screen.queryByText(/that signature locks the key/i)).not.toBeInTheDocument();
    });
  });

  it('disables create until the wallet is connected', async () => {
    const user = userEvent.setup();
    render(<CreateWizard onCreate={vi.fn()} walletReady={false} />);
    await fillToReview(user);
    expect(screen.getByTestId('create-agent')).toBeDisabled();
    expect(screen.getByTestId('create-agent')).toHaveTextContent(/connect your wallet/i);
  });
});
