// File: web/tests/capability-grant.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CapabilityGrant } from '@/components/cockpit/CapabilityGrant';
import type { ResolvedPreset } from '@/lib/types';

const RESOLVED: ResolvedPreset = {
  key: 'defi_trader',
  label: 'DeFi Trader',
  description: 'Swap and add liquidity on a fixed protocol + token set.',
  rules: [
    {
      target: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      selector: '0x095ea7b3',
      recipientMode: 'self',
      spenderSet: ['0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
      perCallCap: '100000000',
      windowCapCall: '500000000',
    },
    {
      target: '0xcccccccccccccccccccccccccccccccccccccccc',
      selector: '0x38ed1739',
      recipientMode: 'self',
      spenderSet: [],
      perCallCap: '100000000',
      windowCapCall: '500000000',
    },
  ],
  budgets: [{ token: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', windowCap: '500000000' }],
  denyList: ['new_spender', 'new_recipient', 'bridge'],
};

describe('CapabilityGrant', () => {
  it('renders all six presets and the custom-rule form', () => {
    render(
      <CapabilityGrant
        onResolvePreset={vi.fn()}
        onGrantPresetRule={vi.fn()}
        onApplyCallRule={vi.fn()}
        onRecordPreset={vi.fn()}
        onCustomRule={vi.fn()}
      />,
    );
    expect(screen.getByTestId('preset-defi_trader')).toBeInTheDocument();
    expect(screen.getByTestId('preset-yield_manager')).toBeInTheDocument();
    expect(screen.getByTestId('preset-treasury_topper')).toBeInTheDocument();
    expect(screen.getByTestId('preset-dca')).toBeInTheDocument();
    expect(screen.getByTestId('preset-rebalancer')).toBeInTheDocument();
    expect(screen.getByTestId('preset-leverage_adv')).toBeInTheDocument();
    expect(screen.getByTestId('custom-rule-form')).toBeInTheDocument();
  });

  it('previews a preset via onResolvePreset and shows its rules as a step sequence', async () => {
    const user = userEvent.setup();
    const onResolvePreset = vi.fn().mockResolvedValue(RESOLVED);
    render(
      <CapabilityGrant
        onResolvePreset={onResolvePreset}
        onGrantPresetRule={vi.fn()}
        onApplyCallRule={vi.fn()}
        onRecordPreset={vi.fn()}
        onCustomRule={vi.fn()}
      />,
    );
    await user.click(screen.getByTestId('preset-defi_trader'));
    expect(onResolvePreset).toHaveBeenCalledWith('defi_trader');
    // The sequential grant flow is legible: "Step 1 of 2".
    expect(await screen.findByText(/step 1 of 2/i)).toBeInTheDocument();
  });

  it('submits a custom loosen rule (propose) through onCustomRule', async () => {
    const user = userEvent.setup();
    const onCustomRule = vi.fn().mockResolvedValue(undefined);
    render(
      <CapabilityGrant
        onResolvePreset={vi.fn()}
        onGrantPresetRule={vi.fn()}
        onApplyCallRule={vi.fn()}
        onRecordPreset={vi.fn()}
        onCustomRule={onCustomRule}
      />,
    );
    await user.type(screen.getByTestId('custom-target'), '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    await user.type(screen.getByTestId('custom-selector'), '0x095ea7b3');
    await user.type(screen.getByTestId('custom-per-call'), '100');
    await user.type(screen.getByTestId('custom-window-cap'), '500');
    await user.click(screen.getByTestId('custom-submit'));
    await waitFor(() => expect(onCustomRule).toHaveBeenCalledTimes(1));
    const [action, rule] = onCustomRule.mock.calls[0]!;
    expect(action).toBe('propose');
    expect(rule.target).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(rule.selector).toBe('0x095ea7b3');
    expect(rule.recipientMode).toBe('self');
  });
});
