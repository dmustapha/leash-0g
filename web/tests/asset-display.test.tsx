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

import { parseAssetAmount } from '@/lib/asset';
describe('parseAssetAmount', () => {
  it('parses decimals exactly', () => {
    expect(parseAssetAmount('1', 6)).toBe(1_000_000n);
    expect(parseAssetAmount('1.5', 6)).toBe(1_500_000n);
    expect(parseAssetAmount('0.000001', 6)).toBe(1n);
    expect(parseAssetAmount('5', 18)).toBe(5n * 10n ** 18n);
  });
  it('rejects junk and over-precision rather than rounding', () => {
    expect(parseAssetAmount('0.0000001', 6)).toBeNull();
    expect(parseAssetAmount('-1', 6)).toBeNull();
    expect(parseAssetAmount('1e3', 6)).toBeNull();
    expect(parseAssetAmount('', 6)).toBeNull();
    expect(parseAssetAmount('1.', 6)).toBeNull();
  });
});

// ── Beta step 3b (display gaps): forms speak the token, permission rows are named ──────────────
import userEvent from '@testing-library/user-event';
import { CapabilityGrant } from '@/components/cockpit/CapabilityGrant';
import { CapabilityEnvelope } from '@/components/cockpit/CapabilityEnvelope';
import type { CapabilityEnvelopeView } from '@/lib/types';

const NOVL = { symbol: 'NOVL', decimals: 18 };
const noopGrant = {
  onResolvePreset: vi.fn(),
  onGrantPresetRule: vi.fn(),
  onApplyCallRule: vi.fn(),
  onRecordPreset: vi.fn(),
  onCustomRule: vi.fn(),
};

describe('amount fields speak the token', () => {
  it('a known token takes "5" and sends exact base units', async () => {
    const propose = vi.fn().mockResolvedValue(undefined);
    render(
      <CapabilityGrant {...noopGrant} onProposeBudget={propose} onApplyBudget={vi.fn()} unitFor={(t) => (t.toLowerCase() === TOKEN ? NOVL : null)} />,
    );
    const u = userEvent.setup();
    await u.type(screen.getByTestId('budget-token'), TOKEN);
    expect(screen.getByText('Budget (NOVL)')).toBeInTheDocument();
    await u.type(screen.getByTestId('budget-cap'), '5');
    await u.click(screen.getByTestId('budget-propose'));
    expect(propose).toHaveBeenCalledWith(TOKEN, (5n * 10n ** 18n).toString());
    expect(screen.queryByText(/base units/i)).toBeNull();
  });

  it('a token we cannot name falls back to an honest smallest-unit input', async () => {
    render(<CapabilityGrant {...noopGrant} onProposeBudget={vi.fn()} onApplyBudget={vi.fn()} unitFor={() => null} />);
    expect(screen.getByText('Budget (smallest unit of the token)')).toBeInTheDocument();
    expect(screen.getAllByText(/could not read this token/i).length).toBeGreaterThan(0);
  });

  it('over-precise input is flagged, not rounded', async () => {
    render(<CapabilityGrant {...noopGrant} onProposeBudget={vi.fn()} onApplyBudget={vi.fn()} unitFor={() => ({ symbol: 'USDC', decimals: 6 })} />);
    await userEvent.setup().type(screen.getByTestId('budget-cap'), '0.0000001');
    expect(screen.getByRole('alert')).toHaveTextContent(/at most 6 decimals/);
    expect(screen.getByTestId('budget-cap')).toHaveValue('0.0000001'); // typing "0." never wiped the text
  });
});

describe('standing permissions are named', () => {
  const env: CapabilityEnvelopeView = {
    grants: [
      {
        id: 'g-9', agentId: 'a', ownerAddr: '0x3333333333333333333333333333333333333333',
        target: TOKEN, selector: '0x095ea7b3', recipientMode: 'self',
        spenderSet: ['0x94cc0000000000000000000000000000000c2bc4'],
        perCallCap: '1000000000000000000', windowCapCall: '5000000000000000000',
        codehash: null, source: 'preset', status: 'active', txHash: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
    ],
    presets: [],
    recentRequests: [],
    labels: {
      [TOKEN]: { name: 'NOVL token', symbol: 'NOVL', decimals: 18 },
      '0x94cc0000000000000000000000000000000c2bc4': { name: 'the DEX router', symbol: null, decimals: null },
    },
  };
  it('shows the contract by name and its cap in the token unit, never a bare address or raw wei', () => {
    render(<CapabilityEnvelope envelope={env} />);
    const row = screen.getByTestId('grant-g-9');
    expect(row).toHaveTextContent('NOVL token');
    expect(row).toHaveTextContent('up to 1 NOVL per call');
    expect(row).toHaveTextContent('the DEX router');
    expect(row.textContent).not.toMatch(/1000000000000000000/);
  });
  it('without labels (older backend) it still renders the short address', () => {
    const { labels: _l, ...bare } = env;
    void _l;
    render(<CapabilityEnvelope envelope={bare} />);
    expect(screen.getByTestId('grant-g-9')).toHaveTextContent('0x5857');
  });
});

// ── S-4 / S-6 ───────────────────────────────────────────────────────────────────────────────────
import { GasRoutePlan } from '@/components/cockpit/GasRoutePlan';
import type { GasSurveyView } from '@/lib/types';

describe('S-4: the gas panel does not contradict itself', () => {
  const survey = (mode: string, sessionNativeWei: string) =>
    ({
      homeChainId: 84532,
      chains: [{ chainId: 84532, name: 'Base Sepolia', status: 'ok', sessionNativeWei, accountNativeWei: '0', spendableTokens: [{ token: '0x1', balance: '1' }, { token: '0x2', balance: '1' }] }],
      route: { mode, legs: [], ask: null },
    }) as unknown as GasSurveyView;
  it('a non-zero balance the plan calls insufficient reads "running low", not "has gas"', () => {
    render(<GasRoutePlan survey={survey('ask-owner', '1000')} />);
    const row = screen.getByTestId('gas-chain-84532');
    expect(row).toHaveTextContent('gas is running low');
    expect(row).not.toHaveTextContent('has gas');
  });
  it('when the plan says it can act now, "has gas" stands', () => {
    render(<GasRoutePlan survey={survey('has-native', '1000')} />);
    expect(screen.getByTestId('gas-chain-84532')).toHaveTextContent('has gas');
  });
});

// ── AQ-FND S1: blocked-send banner ──────────────────────────────────────────────────────────────
import { SendBlockedBanner } from '@/components/cockpit/SendBlockedBanner';
describe('SendBlockedBanner', () => {
  it('says why sending is paused and offers the one action that clears it', async () => {
    const onClear = vi.fn().mockResolvedValue(undefined);
    render(<SendBlockedBanner block={{ intentId: 'i1', reason: 'nonce consumed without a receipt for our tx', txHash: '0xabc', chainId: 84532 }} onClear={onClear} />);
    expect(screen.getByTestId('send-blocked-banner')).toHaveTextContent('Sending is paused');
    expect(screen.getByTestId('send-blocked-banner')).toHaveTextContent('nothing can be paid twice');
    await userEvent.setup().click(screen.getByTestId('send-blocked-clear'));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
