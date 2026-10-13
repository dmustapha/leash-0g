// File: web/tests/networks-panel.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NetworksPanel } from '@/components/cockpit/NetworksPanel';
import { ApiError } from '@/lib/api';
import { staticChainMapDrift, rpcUrlFor, chainDisplayName } from '@/lib/networks';
import { config } from '@/lib/config';
import type { AgentNetworksView, NetworkChain } from '@/lib/types';

// SCOPE-E-1 drift guard (tear-apart 2026-10-13): the static per-chain maps must
// cover the same chains, or rpcUrlFor silently falls back to the home RPC → a
// wrong-chain write. These assert the maps stay consistent as chains are added.
describe('networks.ts static-map drift guard (SCOPE-E-1)', () => {
  it('RPC / name / symbol / explorer maps cover the SAME chain set', () => {
    expect(staticChainMapDrift()).toEqual([]);
  });
  it('every supported non-home chain resolves to a chain-specific RPC (not the home fallback)', () => {
    for (const chainId of [84532, 11155111, 421614, 46630]) {
      expect(chainDisplayName(chainId)).not.toMatch(/^Chain \d+$/);
      expect(rpcUrlFor(chainId)).not.toBe(config.rpcUrl);
    }
  });
});

const ACCOUNT = '0x1111111111111111111111111111111111111111' as const;

const NETWORKS: NetworkChain[] = [
  { chainId: 16602, name: '0G Galileo', capabilities: [] },
  { chainId: 84532, name: 'Base Sepolia', capabilities: [] },
];

const VIEW: AgentNetworksView = {
  accountAddr: ACCOUNT,
  onboardable: true,
  homeChainId: 16602,
  chains: [
    { chainId: 16602, accountAddr: ACCOUNT, role: 'home' },
    {
      chainId: 84532,
      accountAddr: ACCOUNT,
      role: 'onboarded',
      createTx: '0xaaaa',
      registerTx: '0xbbbb',
      adopted: false,
    },
  ],
};

describe('NetworksPanel', () => {
  it('shows home + onboarded rows with chain names and the same-address verification copy', () => {
    render(<NetworksPanel view={VIEW} networks={NETWORKS} onOnboard={vi.fn()} />);
    expect(screen.getByTestId('network-row-16602')).toHaveTextContent('0G Galileo');
    expect(screen.getByTestId('network-row-16602')).toHaveTextContent('home network');
    expect(screen.getByTestId('network-row-84532')).toHaveTextContent('Base Sepolia');
    expect(screen.getByTestId('network-row-84532')).toHaveTextContent(
      'Same CREATE2 address, byte-exact tuple replay',
    );
  });

  it('links onboarded txs to the chain explorer', () => {
    render(<NetworksPanel view={VIEW} networks={NETWORKS} onOnboard={vi.fn()} />);
    const deploy = screen.getByRole('link', { name: /deploy tx/i });
    expect(deploy).toHaveAttribute('href', 'https://sepolia.basescan.org/tx/0xaaaa');
    const register = screen.getByRole('link', { name: /register tx/i });
    expect(register).toHaveAttribute('href', 'https://sepolia.basescan.org/tx/0xbbbb');
  });

  it('offers only chains the agent is NOT already on, and onboards through onOnboard', async () => {
    const user = userEvent.setup();
    const onOnboard = vi.fn().mockResolvedValue({ chainId: 84532, accountAddr: ACCOUNT });
    const oneChain: AgentNetworksView = {
      ...VIEW,
      chains: [{ chainId: 16602, accountAddr: ACCOUNT, role: 'home' }],
    };
    render(<NetworksPanel view={oneChain} networks={NETWORKS} onOnboard={onOnboard} />);
    const select = screen.getByTestId('onboard-chain-select');
    // Base Sepolia is offered; the home chain (16602) is not.
    expect(select).toHaveTextContent('Base Sepolia');
    expect(select).not.toHaveTextContent('0G Galileo');
    await user.selectOptions(select, '84532');
    await user.click(screen.getByTestId('onboard-confirm-btn'));
    expect(onOnboard).toHaveBeenCalledWith(84532);
    expect(await screen.findByTestId('onboard-success')).toHaveTextContent('Base Sepolia');
  });

  it('renders a typed refusal reason as plain language, never the raw code', async () => {
    const user = userEvent.setup();
    const onOnboard = vi.fn().mockRejectedValue(
      new ApiError(409, 'refused', {
        error: { message: 'refused', reason: 'tuple_prediction_mismatch' },
      }),
    );
    const oneChain: AgentNetworksView = {
      ...VIEW,
      chains: [{ chainId: 16602, accountAddr: ACCOUNT, role: 'home' }],
    };
    render(<NetworksPanel view={oneChain} networks={NETWORKS} onOnboard={onOnboard} />);
    await user.selectOptions(screen.getByTestId('onboard-chain-select'), '84532');
    await user.click(screen.getByTestId('onboard-confirm-btn'));
    const err = await screen.findByTestId('onboard-error');
    expect(err).toHaveTextContent(/no longer predicts this account.s address/i);
    expect(err).not.toHaveTextContent('tuple_prediction_mismatch');
  });

  it('hides the onboard action and explains why when the account is not onboardable', () => {
    render(
      <NetworksPanel view={{ ...VIEW, onboardable: false }} networks={NETWORKS} onOnboard={vi.fn()} />,
    );
    expect(screen.queryByTestId('onboard-form')).not.toBeInTheDocument();
    expect(screen.getByTestId('not-onboardable')).toHaveTextContent(/predates deterministic deployment/i);
  });
});
