// Supervised-handoff approval card (spec §8 Frontend row): the delegation-
// sourced approval rides the SAME card surface as Phase-1 approvals — this
// pins that a handoff-shaped event renders and both decisions dispatch.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApprovalCard } from '@/components/cockpit/ApprovalCard';

const HANDOFF_EVENT = {
  type: 'approval' as const,
  approvalId: 'appr-handoff-1',
  summary: "handoff awaiting your approval: 'transfer.request' from sentinel-a to agent exec-b",
  ts: new Date().toISOString(),
};

describe('supervised handoff approval card', () => {
  it('renders the handoff summary and approves', async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalCard approval={HANDOFF_EVENT} onDecide={onDecide} />);
    expect(screen.getByText(/handoff awaiting your approval/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /approve/i }));
    expect(onDecide).toHaveBeenCalledWith('approve', undefined);
  });

  it('denies a handoff', async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalCard approval={HANDOFF_EVENT} onDecide={onDecide} />);
    await userEvent.click(screen.getByRole('button', { name: /deny/i }));
    expect(onDecide).toHaveBeenCalledWith('deny', undefined);
  });
});
