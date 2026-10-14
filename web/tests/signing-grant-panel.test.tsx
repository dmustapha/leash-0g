// File: web/tests/signing-grant-panel.test.tsx
// RH2 B2 (TA-ABI-5 close): the owner governed-signing grant surface. Proves the panel renders the
// reviewed descriptors + standing grants, the propose→apply loosen flow, the instant tighten/remove,
// the always-explicit confirm gate, and the PLAIN-TEXT UNVERIFIED intent (no innerHTML).
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SigningGrantPanel } from '@/components/cockpit/SigningGrantPanel';
import type { SigningDescriptorView, SigningRuleView } from '@/lib/types';

const ZERO = '0x0000000000000000000000000000000000000000';
const TOKEN = '0x1111111111111111111111111111111111111111';
const SPENDER = '0x2222222222222222222222222222222222222222';

function descriptor(over: Partial<SigningDescriptorView> = {}): SigningDescriptorView {
  return {
    descriptorId: 1,
    key: 'erc2612',
    label: 'ERC-2612 permit',
    protocol: 'erc2612',
    sensitive: false,
    onChainGrant: {
      descriptorId: 1,
      domainSeparator: ('0x' + 'ab'.repeat(32)) as `0x${string}`,
      typeHash: ('0x' + 'cd'.repeat(32)) as `0x${string}`,
      numFields: 5,
      spenderIndex: 1,
      amountIndex: 2,
      deadlineIndex: 3,
      nestedTypeHash: ZERO as `0x${string}`,
      nestedLeafStart: 0,
      nestedLeafCount: 0,
      expiryLeafIndex: 255,
      kind: 0,
      buyToken: ZERO as `0x${string}`,
      tokenCaps: [],
      tokenCapsHash: ZERO as `0x${string}`,
    },
    ...over,
  };
}

const AVAILABLE = [descriptor()];
const NOOP = {
  onProposeGrant: vi.fn(),
  onApplyGrant: vi.fn(),
  onTightenGrant: vi.fn(),
  onRemoveGrant: vi.fn(),
};

describe('SigningGrantPanel', () => {
  it('renders the reviewed descriptors with a plain-text UNVERIFIED intent (no innerHTML)', () => {
    render(<SigningGrantPanel available={AVAILABLE} rules={[]} {...NOOP} />);
    expect(screen.getByTestId('signing-grant-panel')).toBeInTheDocument();
    const intent = screen.getByTestId('signing-intent-1');
    expect(intent).toHaveTextContent('UNVERIFIED');
    expect(intent).toHaveTextContent(/approval permit/i);
    // Plain text only — no injected markup inside the intent block.
    expect(intent.querySelector('script')).toBeNull();
    expect(intent.innerHTML).not.toContain('<img');
  });

  it('shows the empty state when no descriptors are grantable', () => {
    render(<SigningGrantPanel available={[]} rules={[]} {...NOOP} />);
    expect(screen.getByTestId('signing-empty')).toBeInTheDocument();
  });

  it('marks a descriptor armed when a standing rule mirrors it', () => {
    const rule: SigningRuleView = {
      descriptorId: 1,
      spenderSet: [SPENDER],
      perIntentCap: '1000',
      maxDeadlineWindow: 3600,
      token: TOKEN,
      active: true,
    };
    render(<SigningGrantPanel available={AVAILABLE} rules={[rule]} {...NOOP} />);
    expect(screen.getByTestId('signing-active-1')).toBeInTheDocument();
    expect(screen.getByTestId('signing-current-1')).toHaveTextContent('1000');
  });

  it('blocks propose until the explicit confirm is checked, then calls onProposeGrant with the form args', async () => {
    const user = userEvent.setup();
    const onProposeGrant = vi.fn().mockResolvedValue(undefined);
    render(<SigningGrantPanel available={AVAILABLE} rules={[]} {...NOOP} onProposeGrant={onProposeGrant} />);

    await user.type(screen.getByTestId('signing-cap-1'), '1000');
    await user.clear(screen.getByTestId('signing-window-1'));
    await user.type(screen.getByTestId('signing-window-1'), '3600');
    await user.type(screen.getByTestId('signing-token-1'), TOKEN);
    await user.type(screen.getByTestId('signing-spenders-1'), SPENDER);

    // Without the confirm checkbox, propose is refused with an explicit error.
    await user.click(screen.getByTestId('signing-propose-1'));
    expect(onProposeGrant).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/confirm/i);

    await user.click(screen.getByTestId('signing-confirm-1'));
    await user.click(screen.getByTestId('signing-propose-1'));
    expect(onProposeGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        descriptor: expect.objectContaining({ descriptorId: 1 }),
        spenders: [SPENDER],
        perIntentCap: '1000',
        maxDeadlineWindow: 3600,
        token: TOKEN,
      }),
    );
  });

  it('surfaces the apply step after a successful propose (timelocked loosen)', async () => {
    const user = userEvent.setup();
    const onProposeGrant = vi.fn().mockResolvedValue(undefined);
    const onApplyGrant = vi.fn().mockResolvedValue(undefined);
    render(
      <SigningGrantPanel available={AVAILABLE} rules={[]} {...NOOP} onProposeGrant={onProposeGrant} onApplyGrant={onApplyGrant} />,
    );
    await user.type(screen.getByTestId('signing-cap-1'), '1000');
    await user.type(screen.getByTestId('signing-token-1'), TOKEN);
    await user.type(screen.getByTestId('signing-spenders-1'), SPENDER);
    await user.click(screen.getByTestId('signing-confirm-1'));
    await user.click(screen.getByTestId('signing-propose-1'));

    const apply = await screen.findByTestId('signing-apply-1');
    await user.click(apply);
    expect(onApplyGrant).toHaveBeenCalledTimes(1);
  });

  it('tighten is instant (no confirm wall change) and remove calls onRemoveGrant', async () => {
    const user = userEvent.setup();
    const onTightenGrant = vi.fn().mockResolvedValue(undefined);
    const onRemoveGrant = vi.fn().mockResolvedValue(undefined);
    render(
      <SigningGrantPanel available={AVAILABLE} rules={[]} {...NOOP} onTightenGrant={onTightenGrant} onRemoveGrant={onRemoveGrant} />,
    );

    // Tighten: instant restriction.
    await user.selectOptions(screen.getByTestId('signing-action-1'), 'tighten');
    await user.type(screen.getByTestId('signing-cap-1'), '500');
    await user.type(screen.getByTestId('signing-token-1'), TOKEN);
    await user.click(screen.getByTestId('signing-confirm-1'));
    await user.click(screen.getByTestId('signing-tighten-1'));
    expect(onTightenGrant).toHaveBeenCalledWith(
      expect.objectContaining({ perIntentCap: '500', token: TOKEN }),
    );

    // Remove: instant, no confirm needed.
    await user.selectOptions(screen.getByTestId('signing-action-1'), 'remove');
    await user.click(screen.getByTestId('signing-remove-1'));
    expect(onRemoveGrant).toHaveBeenCalledWith(expect.objectContaining({ descriptorId: 1 }));
  });

  it('describes a batch descriptor by its reviewed token count (plain text)', () => {
    const batch = descriptor({
      descriptorId: 3,
      key: 'permit2-batch',
      label: 'Permit2 batch',
      protocol: 'permit2',
      onChainGrant: {
        ...descriptor().onChainGrant,
        descriptorId: 3,
        kind: 2,
        tokenCaps: [
          { token: TOKEN as `0x${string}`, cap: '1000' },
          { token: SPENDER as `0x${string}`, cap: '2000' },
        ],
      },
    });
    render(<SigningGrantPanel available={[batch]} rules={[]} {...NOOP} />);
    const intent = within(screen.getByTestId('signing-descriptor-3')).getByTestId('signing-intent-3');
    expect(intent).toHaveTextContent(/batch permit2 approval across 2 reviewed tokens/i);
  });
});
