// File: web/tests/guardian-panel.test.tsx
// setGuardian surface: has-guardian / none / replacing / removing (escape hatch) states,
// address validation, and the wallet tx flow.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GuardianPanel } from '@/components/cockpit/GuardianPanel';
import { ZERO_ADDRESS } from '@/lib/chain';

const GUARDIAN = '0x4444444444444444444444444444444444444444' as const;
const NEW_GUARDIAN = '0x5555555555555555555555555555555555555555' as const;

describe('GuardianPanel', () => {
  it('shows the current guardian address and both actions', () => {
    render(<GuardianPanel guardian={GUARDIAN} onSetGuardian={vi.fn()} />);
    expect(screen.getByTestId('guardian-addr')).toHaveAttribute('title', GUARDIAN);
    expect(screen.getByTestId('guardian-edit-btn')).toHaveTextContent(/replace guardian/i);
    expect(screen.getByTestId('guardian-remove-btn')).toBeInTheDocument();
  });

  it('zero address renders as "none" with no remove action', () => {
    render(<GuardianPanel guardian={ZERO_ADDRESS} onSetGuardian={vi.fn()} />);
    expect(screen.getByTestId('guardian-none')).toBeInTheDocument();
    expect(screen.getByTestId('guardian-edit-btn')).toHaveTextContent(/set guardian/i);
    expect(screen.queryByTestId('guardian-remove-btn')).not.toBeInTheDocument();
  });

  it('shows a loading state while the guardian is unknown', () => {
    render(<GuardianPanel guardian={undefined} onSetGuardian={vi.fn()} />);
    expect(screen.getByTestId('guardian-loading')).toBeInTheDocument();
  });

  it('replacing validates the address then fires the wallet tx', async () => {
    const user = userEvent.setup();
    const onSetGuardian = vi.fn().mockResolvedValue('0xsettx');
    render(<GuardianPanel guardian={GUARDIAN} onSetGuardian={onSetGuardian} />);
    await user.click(screen.getByTestId('guardian-edit-btn'));

    await user.type(screen.getByLabelText('New guardian address'), 'not-an-address');
    await user.click(screen.getByTestId('guardian-save-btn'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/valid wallet address/i);
    expect(onSetGuardian).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText('New guardian address'));
    await user.type(screen.getByLabelText('New guardian address'), NEW_GUARDIAN);
    await user.click(screen.getByTestId('guardian-save-btn'));
    expect(onSetGuardian).toHaveBeenCalledWith(NEW_GUARDIAN);
    expect(await screen.findByTestId('guardian-tx')).toHaveTextContent('0xsettx');
  });

  it('removing confirms the escape hatch and calls setGuardian(0)', async () => {
    const user = userEvent.setup();
    const onSetGuardian = vi.fn().mockResolvedValue('0xremovetx');
    render(<GuardianPanel guardian={GUARDIAN} onSetGuardian={onSetGuardian} />);
    await user.click(screen.getByTestId('guardian-remove-btn'));
    const confirm = screen.getByTestId('guardian-remove-confirm');
    expect(confirm).toHaveTextContent(/only your wallet can\s+revoke/i);
    expect(onSetGuardian).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('guardian-remove-confirm-btn'));
    expect(onSetGuardian).toHaveBeenCalledWith(ZERO_ADDRESS);
  });
});
