// File: web/tests/gas-policy-toggle.test.tsx
// AQ-FND M-3 inc-2: the relayer opt-in toggle (OFF by default, optimistic, reverts on failure)
// and the per-chain gas route display ("couldn't read" is never shown as zero).
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GasPolicyToggle } from '@/components/cockpit/GasPolicyToggle';
import { GasRoutePlan } from '@/components/cockpit/GasRoutePlan';
import type { GasSurveyView } from '@/lib/types';

describe('GasPolicyToggle', () => {
  it('renders OFF by default with the honest relayer copy', () => {
    render(<GasPolicyToggle initial={false} setGasPolicy={vi.fn()} />);
    expect(screen.getByTestId('gas-policy-switch')).not.toBeChecked();
    expect(screen.getByTestId('gas-policy-state')).toHaveTextContent('off');
    expect(screen.getByTestId('gas-policy-toggle')).toHaveTextContent('This is a convenience, not self-funding');
  });

  it('clicking calls setGasPolicy(true) and shows the new state', async () => {
    const setGasPolicy = vi.fn().mockResolvedValue({ ok: true });
    render(<GasPolicyToggle initial={false} setGasPolicy={setGasPolicy} />);
    await userEvent.click(screen.getByTestId('gas-policy-switch'));
    expect(setGasPolicy).toHaveBeenCalledWith(true);
    await waitFor(() => expect(screen.getByTestId('gas-policy-switch')).toBeChecked());
    expect(screen.getByTestId('gas-policy-state')).toHaveTextContent('relayer allowed');
    expect(screen.queryByTestId('gas-policy-error')).toBeNull();
  });

  it('a failed save reverts the switch and says so', async () => {
    const setGasPolicy = vi.fn().mockRejectedValue(new Error('network down'));
    render(<GasPolicyToggle initial={false} setGasPolicy={setGasPolicy} />);
    await userEvent.click(screen.getByTestId('gas-policy-switch'));
    expect(setGasPolicy).toHaveBeenCalledWith(true);
    await waitFor(() => expect(screen.getByTestId('gas-policy-error')).toHaveTextContent("Couldn't save that"));
    expect(screen.getByTestId('gas-policy-switch')).not.toBeChecked();
    expect(screen.getByTestId('gas-policy-state')).toHaveTextContent('off');
  });

  it('starts ON when the agent already opted in, and turning it off calls setGasPolicy(false)', async () => {
    const setGasPolicy = vi.fn().mockResolvedValue({ ok: true });
    render(<GasPolicyToggle initial setGasPolicy={setGasPolicy} />);
    expect(screen.getByTestId('gas-policy-switch')).toBeChecked();
    await userEvent.click(screen.getByTestId('gas-policy-switch'));
    expect(setGasPolicy).toHaveBeenCalledWith(false);
  });
});

const SURVEY: GasSurveyView = {
  homeChainId: 16602,
  allowRelayerBootstrap: false,
  chains: [
    { chainId: 16602, name: '0G Galileo', status: 'ok', sessionNativeWei: '0', accountNativeWei: '0', spendableTokens: [{ token: '0x1111111111111111111111111111111111111111', balance: '5' }] },
    { chainId: 84532, name: 'Base Sepolia', status: 'unknown', sessionNativeWei: '0', accountNativeWei: '0', spendableTokens: [] },
  ],
  route: {
    mode: 'ask-owner',
    reason: 'no gas-feasible self-funding route',
    legs: [],
    ask: { surveyedChains: [16602], unknownChains: [84532], missing: ['DEX route on chain 16602', 'account native funds on chain 16602 (>= 2000000000000000 wei)'] },
  },
};

describe('GasRoutePlan', () => {
  it('shows an unreadable network as "couldn\'t read", never as zero, and the plain-language plan', () => {
    render(<GasRoutePlan survey={SURVEY} />);
    expect(screen.getByTestId('gas-chain-84532')).toHaveTextContent("couldn't read this network");
    expect(screen.getByTestId('gas-chain-84532')).not.toHaveTextContent('no gas');
    expect(screen.getByTestId('gas-chain-16602')).toHaveTextContent('no gas · 1 spendable token');
    expect(screen.getByTestId('gas-route-sentence')).toHaveTextContent('it will ask you, once');
  });

  it('turns chain ids and wei figures in the unblock list into names (no number walls)', () => {
    render(<GasRoutePlan survey={SURVEY} />);
    const panel = screen.getByTestId('gas-route-plan');
    expect(panel).toHaveTextContent('DEX route on 0G Galileo');
    expect(panel).toHaveTextContent('account native funds on 0G Galileo');
    expect(panel).not.toHaveTextContent('wei');
  });

  it('renders nothing until the survey is loaded', () => {
    const { container } = render(<GasRoutePlan survey={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
