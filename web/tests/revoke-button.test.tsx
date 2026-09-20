// File: web/tests/revoke-button.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RevokeButton } from '@/components/cockpit/RevokeButton';

describe('RevokeButton', () => {
  it('requires an explicit confirm before revoking', async () => {
    const user = userEvent.setup();
    const onRevoke = vi.fn().mockResolvedValue(undefined);
    render(<RevokeButton onRevoke={onRevoke} onRevokeOnchain={vi.fn()} revoked={false} />);
    await user.click(screen.getByTestId('revoke-btn'));
    expect(onRevoke).not.toHaveBeenCalled(); // confirm step first
    await user.click(screen.getByTestId('confirm-revoke-btn'));
    expect(onRevoke).toHaveBeenCalledOnce();
  });

  it('cancel backs out without revoking', async () => {
    const user = userEvent.setup();
    const onRevoke = vi.fn();
    render(<RevokeButton onRevoke={onRevoke} onRevokeOnchain={vi.fn()} revoked={false} />);
    await user.click(screen.getByTestId('revoke-btn'));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onRevoke).not.toHaveBeenCalled();
    expect(screen.getByTestId('revoke-btn')).toBeInTheDocument();
  });

  it('exposes the wallet fallback behind a disclosure', async () => {
    const user = userEvent.setup();
    const onRevokeOnchain = vi.fn().mockResolvedValue('0xtxhash');
    render(<RevokeButton onRevoke={vi.fn()} onRevokeOnchain={onRevokeOnchain} revoked={false} />);
    await user.click(screen.getByText(/revoke directly from your wallet/i));
    await user.click(screen.getByTestId('revoke-onchain-btn'));
    expect(onRevokeOnchain).toHaveBeenCalledOnce();
  });

  it('shows the revoked state', () => {
    render(<RevokeButton onRevoke={vi.fn()} onRevokeOnchain={vi.fn()} revoked />);
    expect(screen.getByTestId('revoked-pill')).toHaveTextContent(/revoked/i);
    expect(screen.queryByTestId('revoke-btn')).not.toBeInTheDocument();
  });

  it('re-arm requires a confirm and states only the owner wallet can do it', async () => {
    const user = userEvent.setup();
    const onRearm = vi.fn().mockResolvedValue('0xreamtx');
    render(<RevokeButton onRevoke={vi.fn()} onRevokeOnchain={vi.fn()} onRearm={onRearm} revoked />);
    await user.click(screen.getByTestId('rearm-btn'));
    expect(onRearm).not.toHaveBeenCalled(); // confirm step first
    expect(screen.getByRole('alertdialog')).toHaveTextContent(/only the owner wallet can re-arm/i);
    await user.click(screen.getByTestId('confirm-rearm-btn'));
    expect(onRearm).toHaveBeenCalledOnce();
  });
});
