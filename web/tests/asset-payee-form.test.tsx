// File: web/tests/asset-payee-form.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { decodeAbiParameters } from 'viem';
import { CapabilityGrant } from '@/components/cockpit/CapabilityGrant';
import { v6AssetPayeePayload } from '@/lib/chain';

/**
 * Beat-5 fix (D5-1): a token is spendable only with a budget AND a per-asset approved recipient. The
 * cockpit had no control for the second half. These pin the form flow and the on-chain payload shape.
 */
const TOKEN = '0x58574d4fbb5656f54b89e43b9181e3372c30d2a9';
const PAYEE = '0xc211C942946011859ca634F22400d80570ED12A5';
const base = {
  onResolvePreset: vi.fn(),
  onGrantPresetRule: vi.fn(),
  onApplyCallRule: vi.fn(),
  onRecordPreset: vi.fn(),
  onCustomRule: vi.fn(),
};

describe('v6AssetPayeePayload', () => {
  it('encodes exactly abi.encode(asset, payee) — what applyGoverned kind 4 decodes', () => {
    const [asset, payee] = decodeAbiParameters([{ type: 'address' }, { type: 'address' }], v6AssetPayeePayload(TOKEN, PAYEE));
    expect(asset.toLowerCase()).toBe(TOKEN);
    expect(payee.toLowerCase()).toBe(PAYEE.toLowerCase());
  });
});

describe('AssetPayeeForm', () => {
  it('is absent unless the page supplies the v6 callbacks', () => {
    render(<CapabilityGrant {...base} />);
    expect(screen.queryByTestId('asset-payee-form')).toBeNull();
  });

  it('prefills the recipient, proposes, then applies the SAME (token, recipient) pair', async () => {
    const onPropose = vi.fn().mockResolvedValue(undefined);
    const onApply = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<CapabilityGrant {...base} onProposeAssetPayee={onPropose} onApplyAssetPayee={onApply} defaultPayee={PAYEE} />);
    expect(screen.getByTestId('payee-addr')).toHaveValue(PAYEE);
    await user.type(screen.getByTestId('payee-token'), TOKEN);
    await user.click(screen.getByTestId('payee-propose'));
    await waitFor(() => expect(onPropose).toHaveBeenCalledWith(TOKEN, PAYEE));
    await user.click(await screen.findByTestId('payee-apply'));
    await waitFor(() => expect(onApply).toHaveBeenCalledWith(TOKEN, PAYEE));
    expect(await screen.findByTestId('payee-propose')).toBeInTheDocument(); // reset for the next token
  });

  it('refuses a malformed token or recipient without opening the wallet', async () => {
    const onPropose = vi.fn();
    const user = userEvent.setup();
    render(<CapabilityGrant {...base} onProposeAssetPayee={onPropose} onApplyAssetPayee={vi.fn()} defaultPayee={PAYEE} />);
    await user.type(screen.getByTestId('payee-token'), '0x123');
    await user.click(screen.getByTestId('payee-propose'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/valid token address/i);
    expect(onPropose).not.toHaveBeenCalled();
  });

  it('surfaces a wallet failure and stays on the propose step', async () => {
    const onPropose = vi.fn().mockRejectedValue(new Error('user rejected'));
    const user = userEvent.setup();
    render(<CapabilityGrant {...base} onProposeAssetPayee={onPropose} onApplyAssetPayee={vi.fn()} defaultPayee={PAYEE} />);
    await user.type(screen.getByTestId('payee-token'), TOKEN);
    await user.click(screen.getByTestId('payee-propose'));
    expect(await screen.findByRole('alert')).toHaveTextContent('user rejected');
    expect(screen.getByTestId('payee-propose')).toBeInTheDocument();
  });
});
