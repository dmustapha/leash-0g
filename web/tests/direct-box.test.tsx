// File: web/tests/direct-box.test.tsx
// Phase-5.5 (spec §9): the cockpit command box. type → read it back → confirm calls onConfirm with
// the directionId, the edited draft, and the owner-typed recipient (out-of-band).
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DirectBox } from '@/components/cockpit/DirectBox';
import type { DirectionDraft } from '@/lib/types';

const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

function treasuryDirection(): DirectionDraft {
  return {
    agentId: 'agent-1',
    currentRole: 'treasury',
    understanding: 'Keep the balance at 2 0G.',
    goalPatch: { targetBalanceWei: '2000000000000000000' },
    moneyPower: 'can-move-money',
    unsureFields: [],
    confidence: 'high',
  };
}

describe('DirectBox', () => {
  it('type → read it back → confirm calls api with directionId, edited, recipient', async () => {
    const user = userEvent.setup();
    const onDirect = vi.fn().mockResolvedValue({ id: 'dir-1', draft: treasuryDirection() });
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<DirectBox onDirect={onDirect} onConfirm={onConfirm} />);

    await user.type(screen.getByTestId('direct-intent'), '  keep it at 2 0G  ');
    await user.click(screen.getByTestId('direct-submit'));
    expect(onDirect).toHaveBeenCalledWith('keep it at 2 0G');

    // Read-back appears; a can-move-money role requires a recipient.
    expect(await screen.findByTestId('read-back')).toBeInTheDocument();
    await user.type(screen.getByTestId('rb-recipient'), RECIPIENT);
    await user.click(screen.getByTestId('read-back-confirm'));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    const [directionId, edited, recipient] = onConfirm.mock.calls[0]!;
    expect(directionId).toBe('dir-1');
    expect(recipient).toBe(RECIPIENT);
    expect(edited.goalPatch.targetBalanceWei).toBe('2000000000000000000');
  });

  it('submit is disabled with an empty intent', () => {
    render(<DirectBox onDirect={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByTestId('direct-submit')).toBeDisabled();
  });

  it('a direct failure shows a legible retry, not a blank screen', async () => {
    const user = userEvent.setup();
    const onDirect = vi.fn().mockRejectedValue(new Error('boom'));
    render(<DirectBox onDirect={onDirect} onConfirm={vi.fn()} />);
    await user.type(screen.getByTestId('direct-intent'), 'do a thing');
    await user.click(screen.getByTestId('direct-submit'));
    expect(await screen.findByTestId('direct-error')).toHaveTextContent(/try again/i);
    expect(screen.getByTestId('direct-intent')).toBeInTheDocument();
  });
});
