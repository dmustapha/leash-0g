// File: web/tests/policy-panel.test.tsx
// Pending-change cards: countdown while the timelock runs (Apply disabled), then Apply goes
// active once the eta elapses and fires the matching on-chain apply.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { PolicyPanel } from '@/components/cockpit/PolicyPanel';
import type { AgentDetail } from '@/lib/types';

const DETAIL: AgentDetail = {
  status: 'running',
  policy: {
    perTransferCapWei: '10000000000000000',
    windowCapWei: '50000000000000000',
    windowSeconds: 86400,
    expiresAt: Math.floor(Date.now() / 1000) + 7 * 86400,
    allowlist: ['0x70997970C51812dc3A010C7d01b50e0d17dc79C8'],
  },
  accountBalance: '250000000000000000',
  sessionExpiry: Math.floor(Date.now() / 1000) + 7 * 86400,
  addresses: {
    account: '0x1111111111111111111111111111111111111111',
    sessionKey: '0x2222222222222222222222222222222222222222',
    owner: '0x3333333333333333333333333333333333333333',
  },
};

const NO_PENDING = { policy: 0, allowlist: 0, withdraw: 0 };

describe('PolicyPanel pending changes', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows no pending card when nothing is queued', () => {
    render(
      <PolicyPanel detail={DETAIL} onSubmitPolicy={vi.fn()} pending={NO_PENDING} onApply={vi.fn()} />,
    );
    expect(screen.queryByTestId('pending-policy')).not.toBeInTheDocument();
  });

  it('counts down while locked, then enables Apply and fires onApply', async () => {
    const onApply = vi.fn().mockResolvedValue(undefined);
    const eta = Math.floor(Date.now() / 1000) + 3;
    render(
      <PolicyPanel
        detail={DETAIL}
        onSubmitPolicy={vi.fn()}
        pending={{ ...NO_PENDING, policy: eta }}
        onApply={onApply}
      />,
    );

    // Locked: countdown text, Apply disabled.
    expect(screen.getByTestId('pending-policy-eta')).toHaveTextContent(/unlocks in/i);
    expect(screen.getByTestId('apply-policy')).toBeDisabled();

    // Let the eta elapse; the 1s tick flips the card to ready.
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByTestId('pending-policy-eta')).toHaveTextContent(/ready to apply/i);
    const apply = screen.getByTestId('apply-policy');
    expect(apply).toBeEnabled();

    fireEvent.click(apply);
    await act(async () => {
      await Promise.resolve();
    });
    expect(onApply).toHaveBeenCalledWith('policy');
  });

  it('shows a card per queued change kind', () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    render(
      <PolicyPanel
        detail={DETAIL}
        onSubmitPolicy={vi.fn()}
        pending={{ policy: past, allowlist: past, withdraw: 0 }}
        onApply={vi.fn()}
      />,
    );
    expect(screen.getByTestId('pending-policy')).toBeInTheDocument();
    expect(screen.getByTestId('pending-allowlist')).toBeInTheDocument();
    expect(screen.queryByTestId('pending-withdraw')).not.toBeInTheDocument();
  });

  it('surfaces an apply failure without losing the card', async () => {
    const onApply = vi.fn().mockRejectedValue(new Error('user rejected'));
    const past = Math.floor(Date.now() / 1000) - 10;
    render(
      <PolicyPanel
        detail={DETAIL}
        onSubmitPolicy={vi.fn()}
        pending={{ ...NO_PENDING, allowlist: past }}
        onApply={onApply}
      />,
    );
    fireEvent.click(screen.getByTestId('apply-allowlist'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole('alert')).toHaveTextContent('user rejected');
    expect(screen.getByTestId('apply-allowlist')).toBeEnabled();
  });
});

describe('PolicyPanel — editable expiry/window (G-4) + lifecycle controls', () => {
  it('raising the window length is treated as loosening (timelocked)', async () => {
    vi.useRealTimers();
    const onSubmitPolicy = vi.fn().mockResolvedValue(undefined);
    render(<PolicyPanel detail={DETAIL} onSubmitPolicy={onSubmitPolicy} pending={NO_PENDING} onApply={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /change limits/i }));
    // Caps unchanged; only the window length grows (86400s = 24h → 48h).
    fireEvent.change(screen.getByLabelText(/budget window length/i), { target: { value: '48' } });
    await act(async () => {
      fireEvent.submit(screen.getByLabelText(/access expires/i).closest('form')!);
      await Promise.resolve();
    });
    expect(onSubmitPolicy).toHaveBeenCalledTimes(1);
    const [policy, loosening] = onSubmitPolicy.mock.calls[0]!;
    expect(loosening).toBe(true);
    expect(policy.windowSeconds).toBe(48 * 3600);
    // Expiry is unchanged bar the minute-truncation the datetime-local input imposes.
    expect(Math.abs(policy.expiresAt - DETAIL.policy.expiresAt)).toBeLessThan(60);
  });

  it('raising the expiry is treated as loosening (timelocked)', async () => {
    vi.useRealTimers();
    const onSubmitPolicy = vi.fn().mockResolvedValue(undefined);
    render(<PolicyPanel detail={DETAIL} onSubmitPolicy={onSubmitPolicy} pending={NO_PENDING} onApply={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /change limits/i }));
    const later = new Date((DETAIL.policy.expiresAt + 30 * 86400) * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const local = `${later.getFullYear()}-${pad(later.getMonth() + 1)}-${pad(later.getDate())}T${pad(later.getHours())}:${pad(later.getMinutes())}`;
    fireEvent.change(screen.getByLabelText(/access expires/i), { target: { value: local } });
    await act(async () => {
      fireEvent.submit(screen.getByLabelText(/access expires/i).closest('form')!);
      await Promise.resolve();
    });
    const [, loosening] = onSubmitPolicy.mock.calls[0]!;
    expect(loosening).toBe(true);
  });

  it('"Mark done / wind down" confirms then calls onWindDown', async () => {
    vi.useRealTimers();
    const onWindDown = vi.fn().mockResolvedValue(undefined);
    render(
      <PolicyPanel detail={DETAIL} onSubmitPolicy={vi.fn()} pending={NO_PENDING} onApply={vi.fn()} onWindDown={onWindDown} />,
    );
    fireEvent.click(screen.getByTestId('wind-down-btn'));
    fireEvent.click(screen.getByTestId('confirm-wind-down-btn'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(onWindDown).toHaveBeenCalledTimes(1);
  });
});
