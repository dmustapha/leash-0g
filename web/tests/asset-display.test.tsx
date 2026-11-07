// File: web/tests/asset-display.test.tsx
// Beta step 3b: owner views speak the agent's ASSET. Reproduces the live D1 smoke defects
// ("1.02000000000283 0G", "0 0G" balance, "holds 0 ETH" for a token agent) and pins them fixed.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FleetList } from '@/components/fleet/FleetList';
import { StatusBar } from '@/components/cockpit/StatusBar';
import { agentMoney, formatAssetAmount, formatBuckets } from '@/lib/asset';
import type { AgentDetail, AgentDigest, AgentSummary } from '@/lib/types';

const TOKEN = '0x58574d4fbb5656f54b89e43b9181e3372c30d2a9';

describe('formatAssetAmount (parity with backend/src/asset/format.ts)', () => {
  it('exact, trimmed, dust-safe, honest when decimals unknown', () => {
    expect(formatAssetAmount(1_000_000n, 6, 'USDC')).toBe('1 USDC');
    expect(formatAssetAmount('1020000000000000000', 18, 'NOVL')).toBe('1.02 NOVL');
    expect(formatAssetAmount(2_830_000n, 18, '0G')).toBe('<0.000001 0G');
    expect(formatAssetAmount(1_000_000n, null, null)).toBe('1000000 units');
  });
  it('formatBuckets never mixes assets and never shows a long decimal', () => {
    const out = formatBuckets([
      { chainId: 84532, token: TOKEN, symbol: 'NOVL', decimals: 18, amountWei: '1020000000000000000' },
      { chainId: 84532, token: null, symbol: null, decimals: null, amountWei: '283000' },
    ]);
    expect(out).toBe('1.02 NOVL · <0.000001 ETH');
    expect(out).not.toMatch(/\d\.\d{7,}/);
  });
});

const digest = (over: Partial<AgentDigest>): AgentDigest => ({
  agentId: 'a1', name: 'Base gas keeper', status: 'active', spendWei: '283000', balanceWei: '0', balanceChangeWei: null,
  actions: 3, blocks: 0, modifies: 0, approvals: { approved: 0, denied: 0, expired: 0 }, delegationsTerminal: {}, chainId: 84532,
  spendByAsset: [
    { chainId: 84532, token: TOKEN, symbol: 'NOVL', decimals: 18, amountWei: '1020000000000000000' },
    { chainId: 84532, token: null, symbol: null, decimals: null, amountWei: '283000' },
  ],
  goalAsset: { token: TOKEN, symbol: 'NOVL', decimals: 18, balanceWei: '3980000000000000000' },
  ...over,
});
const agent: AgentSummary = {
  agentId: 'a1', name: 'Base gas keeper', status: 'active',
  accountAddr: '0x1111111111111111111111111111111111111111', sessionKeyAddr: '0x2222222222222222222222222222222222222222',
  accountBalanceWei: '0', createdAt: '2026-11-06T12:00:00.000Z',
};

describe('FleetList — token agent card', () => {
  it('shows spend + balance in the token, not "0G", with no long decimals', () => {
    render(<FleetList agents={[agent]} hasMore={false} onLoadMore={vi.fn()} digestByAgent={{ a1: digest({}) }} />);
    const row = screen.getByTestId('fleet-row-a1');
    expect(row).toHaveTextContent('1.02 NOVL');
    expect(row).toHaveTextContent('3.98 NOVL');
    expect(row.textContent).not.toMatch(/0G/);
    expect(row.textContent).not.toMatch(/\d\.\d{7,}/);
  });
  it('agentMoney: a native agent keeps native units in its chain symbol', () => {
    const m = agentMoney(digest({ goalAsset: null, spendByAsset: [{ chainId: 84532, token: null, symbol: null, decimals: null, amountWei: '30000000000000000' }], spendWei: '30000000000000000', balanceWei: '1000000000000000000' }), '0', 84532);
    expect(m.spent).toBe('0.03 ETH');
    expect(m.balance).toBe('1 ETH');
  });
});

const DETAIL: AgentDetail = {
  status: 'paused',
  policy: { perTransferCapWei: '10000000000000000', windowCapWei: '50000000000000000', windowSeconds: 86400, expiresAt: Math.floor(Date.now() / 1000) + 86400, allowlist: [] },
  accountBalance: '0',
  sessionExpiry: Math.floor(Date.now() / 1000) + 86400,
  addresses: { account: '0x1111111111111111111111111111111111111111', sessionKey: '0x2222222222222222222222222222222222222222', owner: '0x3333333333333333333333333333333333333333' },
  goalAsset: { token: TOKEN, symbol: 'NOVL', decimals: 18, balanceWei: '3980000000000000000', enabled: true, perTransferCapWei: '10000000000000000', windowCapWei: '50000000000000000', windowSeconds: 86400 },
};

describe('StatusBar — token agent', () => {
  it('shows the token balance as the account balance and the native coin as a separate gas pill', () => {
    render(<StatusBar detail={DETAIL} currency="ETH" />);
    expect(screen.getByTestId('asset-balance')).toHaveTextContent('3.98 NOVL in account');
    expect(screen.getByTestId('gas-balance')).toHaveTextContent('gas 0 ETH');
  });
  it('a native agent still reads "<n> <coin> in account"', () => {
    const native: Partial<AgentDetail> = { ...DETAIL };
    delete native.goalAsset;
    render(<StatusBar detail={native as AgentDetail} currency="ETH" />);
    expect(screen.queryByTestId('asset-balance')).not.toBeInTheDocument();
    expect(screen.getByText(/0 ETH in account/)).toBeInTheDocument();
  });
});
