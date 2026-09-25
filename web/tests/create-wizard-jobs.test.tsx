// File: web/tests/create-wizard-jobs.test.tsx
// Phase-4 create parity (spec §7/§3b): the three ACP roles. Provider/evaluator
// are spend-incapable (zero caps, empty allowlist); the requester is the sole
// governed spender and ships a settlement-token config (F1) with per-token caps.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CreateWizard, type WizardResult } from '@/components/create/CreateWizard';

const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const TOKEN = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

function okResult(): WizardResult {
  return {
    response: {
      agentId: 'agent-9',
      accountAddr: '0x0000000000000000000000000000000000000001',
      sessionKeyAddr: '0x0000000000000000000000000000000000000002',
      gatewayToken: 'tok_once',
      txHashes: [],
    },
    kekMode: 'signature',
    downloadBackup: vi.fn(),
  };
}

type User = ReturnType<typeof userEvent.setup>;
async function startAndName(user: User) {
  await user.type(screen.getByLabelText('Agent name'), 'Job agent');
  await user.click(screen.getByTestId('wizard-next'));
}

describe('CreateWizard — Phase-4 ACP roles', () => {
  it('provider: spend-incapable, ships {type:provider, serviceSpec}', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(okResult());
    render(<CreateWizard onCreate={onCreate} walletReady />);
    await startAndName(user);

    await user.click(screen.getByTestId('role-provider'));
    await user.click(screen.getByTestId('wizard-next')); // → provider-service
    await user.type(screen.getByLabelText('Service'), 'calibrated probabilities');
    await user.click(screen.getByTestId('wizard-next')); // → expiry
    await user.click(screen.getByTestId('wizard-next')); // → review

    await user.click(screen.getByTestId('create-agent'));
    expect(await screen.findByTestId('create-done')).toBeInTheDocument();

    const input = onCreate.mock.calls[0]?.[0];
    expect(input.policy.perTransferCapWei).toBe('0');
    expect(input.allowlist).toEqual([]);
    expect(input.goal).toEqual({ type: 'provider', serviceSpec: 'calibrated probabilities' });
    expect(input.tokenConfig).toBeUndefined();
  });

  it('evaluator: spend-incapable, ships {type:evaluator, rubricRef}', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(okResult());
    render(<CreateWizard onCreate={onCreate} walletReady />);
    await startAndName(user);

    await user.click(screen.getByTestId('role-evaluator'));
    await user.click(screen.getByTestId('wizard-next')); // → evaluator-rubric
    await user.type(screen.getByLabelText('Rubric'), 'strict calibration');
    await user.click(screen.getByTestId('wizard-next')); // → expiry
    await user.click(screen.getByTestId('wizard-next')); // → review

    await user.click(screen.getByTestId('create-agent'));
    expect(await screen.findByTestId('create-done')).toBeInTheDocument();

    const input = onCreate.mock.calls[0]?.[0];
    expect(input.policy.windowCapWei).toBe('0');
    expect(input.allowlist).toEqual([]);
    expect(input.goal).toEqual({ type: 'evaluator', rubricRef: 'strict calibration' });
  });

  it('requester: sole governed spender — ships the goal + settlement-token config (F1)', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(okResult());
    render(
      <CreateWizard
        onCreate={onCreate}
        walletReady
        jobAgents={{ providers: [{ id: 'prov-1', name: 'My provider' }], evaluators: [{ id: 'eval-1', name: 'My evaluator' }] }}
        // D-A2: the requester is behind the advanced door and needs a saved job spec.
        jobSpecs={[{ ref: 'eth-4000', label: 'ETH price', questionPreview: 'where is ETH heading' }]}
      />,
    );
    await startAndName(user);

    // D-A1: open the advanced door to reach the requester role.
    await user.click(screen.getByTestId('advanced-toggle'));
    await user.click(screen.getByTestId('role-requester'));
    await user.click(screen.getByTestId('wizard-next')); // → requester-config

    // D-A2: the job handle is a picker over saved specs.
    await user.selectOptions(screen.getByTestId('requester-jobspec'), 'eth-4000');
    await user.selectOptions(screen.getByTestId('requester-provider'), 'prov-1');
    await user.selectOptions(screen.getByTestId('requester-evaluator'), 'eval-1');
    await user.type(screen.getByLabelText('Pay the fee to'), RECIPIENT);
    await user.type(screen.getByLabelText('Fee cap per job (token base units)'), '5000000');
    await user.click(screen.getByTestId('wizard-next')); // → token-config

    await user.type(screen.getByLabelText('Settlement token (ERC-20)'), TOKEN);
    await user.type(screen.getByLabelText('Max per settlement (token base units)'), '10000000');
    await user.type(screen.getByLabelText('Max per window (token base units)'), '30000000');
    await user.click(screen.getByTestId('wizard-next')); // → expiry
    await user.click(screen.getByTestId('wizard-next')); // → review

    // Review surfaces the governed settlement details.
    expect(screen.getByTestId('review-summary')).toHaveTextContent('settles ERC-20 only');
    expect(screen.getByTestId('review-summary')).toHaveTextContent('eth-4000');

    await user.click(screen.getByTestId('create-agent'));
    expect(await screen.findByTestId('create-done')).toBeInTheDocument();

    const input = onCreate.mock.calls[0]?.[0];
    expect(input.policy.perTransferCapWei).toBe('0'); // never moves native funds
    expect(input.allowlist).toEqual([RECIPIENT]); // fee recipient is the allowlisted target
    expect(input.goal).toEqual({
      type: 'requester',
      jobSpecSource: 'eth-4000',
      providerAgentId: 'prov-1',
      evaluatorAgentId: 'eval-1',
      feeToken: TOKEN,
      feeRecipient: RECIPIENT,
      feeCapPerJobWei: '5000000',
    });
    expect(input.tokenConfig).toEqual({
      settlementToken: TOKEN, // F1: settlementToken == feeToken
      perTransferCapTokenWei: '10000000',
      windowCapTokenWei: '30000000',
    });
  });

  it('requester: blocks a fee cap above the per-transfer cap (defence in depth, F4)', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(okResult());
    render(
      <CreateWizard
        onCreate={onCreate}
        walletReady
        jobAgents={{ providers: [{ id: 'prov-1', name: 'P' }], evaluators: [{ id: 'eval-1', name: 'E' }] }}
        jobSpecs={[{ ref: 'j', label: 'J', questionPreview: 'q' }]}
      />,
    );
    await startAndName(user);
    await user.click(screen.getByTestId('advanced-toggle'));
    await user.click(screen.getByTestId('role-requester'));
    await user.click(screen.getByTestId('wizard-next'));
    await user.selectOptions(screen.getByTestId('requester-jobspec'), 'j');
    await user.selectOptions(screen.getByTestId('requester-provider'), 'prov-1');
    await user.selectOptions(screen.getByTestId('requester-evaluator'), 'eval-1');
    await user.type(screen.getByLabelText('Pay the fee to'), RECIPIENT);
    await user.type(screen.getByLabelText('Fee cap per job (token base units)'), '99999999');
    await user.click(screen.getByTestId('wizard-next')); // → token-config
    await user.type(screen.getByLabelText('Settlement token (ERC-20)'), TOKEN);
    await user.type(screen.getByLabelText('Max per settlement (token base units)'), '10000000'); // < fee cap
    await user.type(screen.getByLabelText('Max per window (token base units)'), '30000000');
    await user.click(screen.getByTestId('wizard-next')); // should NOT advance (invalid)

    // Still on token-config: the settlement-token heading is present, not the review summary.
    expect(screen.getByRole('heading', { name: /settlement limits/i })).toBeInTheDocument();
    expect(screen.queryByTestId('review-summary')).not.toBeInTheDocument();
  });
});
