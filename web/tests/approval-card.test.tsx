// File: web/tests/approval-card.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApprovalCard } from '@/components/cockpit/ApprovalCard';

const APPROVAL = {
  type: 'approval' as const,
  approvalId: 'apr-1',
  summary: 'Send 0.02 0G to the beneficiary (over your usual pattern)',
  to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const,
  valueWei: '20000000000000000',
};

describe('ApprovalCard', () => {
  it('renders the request in plain language with amount and recipient', () => {
    render(<ApprovalCard approval={APPROVAL} onDecide={vi.fn()} />);
    expect(screen.getByText(APPROVAL.summary)).toBeInTheDocument();
    expect(screen.getAllByText(/0\.02 0G/).length).toBeGreaterThan(0);
  });

  it('approves with an optional reason', async () => {
    const user = userEvent.setup();
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalCard approval={APPROVAL} onDecide={onDecide} />);
    await user.type(screen.getByLabelText(/reason/i), 'looks right');
    await user.click(screen.getByTestId('approve-btn'));
    expect(onDecide).toHaveBeenCalledWith('approve', 'looks right');
  });

  it('denies without a reason (reason omitted, not empty string)', async () => {
    const user = userEvent.setup();
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalCard approval={APPROVAL} onDecide={onDecide} />);
    await user.click(screen.getByTestId('deny-btn'));
    expect(onDecide).toHaveBeenCalledWith('deny', undefined);
  });

  it('surfaces a failure and re-enables the buttons', async () => {
    const user = userEvent.setup();
    const onDecide = vi.fn().mockRejectedValue(new Error('network down'));
    render(<ApprovalCard approval={APPROVAL} onDecide={onDecide} />);
    await user.click(screen.getByTestId('approve-btn'));
    expect(await screen.findByRole('alert')).toHaveTextContent('network down');
    expect(screen.getByTestId('approve-btn')).toBeEnabled();
  });
});
