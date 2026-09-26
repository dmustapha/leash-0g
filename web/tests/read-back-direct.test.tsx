// File: web/tests/read-back-direct.test.tsx
// Phase-5.5 (spec §9): the read-back reused in DIRECT mode over a DirectionDraft. Covers:
// descriptive goalPatch fields render + are editable; the money-power line reflects the draft;
// understanding renders as PLAIN TEXT (no dangerouslySetInnerHTML in source); the recipient is
// blank-required for a can-move-money role and passed OUT-OF-BAND; a cannot-move-money role shows
// no recipient input; and a suggestedPolicy is shown read-only with the time-locked disclosure.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReadBack } from '@/components/create/ReadBack';
import type { DirectionDraft } from '@/lib/types';

const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

function providerDirection(over: Partial<DirectionDraft> = {}): DirectionDraft {
  return {
    agentId: 'agent-1',
    currentRole: 'provider',
    understanding: 'You want it to summarize research papers instead of market questions.',
    goalPatch: { serviceSpec: 'summarize research papers' },
    moneyPower: 'cannot-move-money',
    unsureFields: [],
    confidence: 'high',
    ...over,
  };
}

function treasuryDirection(over: Partial<DirectionDraft> = {}): DirectionDraft {
  return {
    agentId: 'agent-1',
    currentRole: 'treasury',
    understanding: 'You want it to keep the balance at 2 0G instead of 1.',
    goalPatch: { targetBalanceWei: '2000000000000000000', topUpWei: '500000000000000000' },
    suggestedPolicy: { perTransferCapWei: '10000000000000000', windowCapWei: '50000000000000000', windowSeconds: 86400 },
    moneyPower: 'can-move-money',
    unsureFields: [],
    confidence: 'high',
    ...over,
  };
}

describe('ReadBack (direct mode) — redirect quarantine + never-guess-money', () => {
  it('renders the direct-mode header + plain-text understanding', () => {
    render(<ReadBack mode="direct" draft={providerDirection()} onConfirm={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByRole('heading', { name: /how i understand the new task/i })).toBeInTheDocument();
    expect(screen.getByTestId('read-back-understanding')).toHaveTextContent('research papers');
  });

  it('renders the descriptive goalPatch fields and edits flow to onConfirm', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ReadBack mode="direct" draft={providerDirection()} onConfirm={onConfirm} onBack={vi.fn()} />);
    const svc = screen.getByTestId('rb-patch-serviceSpec');
    await user.clear(svc);
    await user.type(svc, 'summarize with citations');
    await user.click(screen.getByTestId('read-back-confirm'));
    const [edited] = onConfirm.mock.calls[0]!;
    expect(edited.goalPatch.serviceSpec).toBe('summarize with citations');
  });

  it('money-power line reflects draft.moneyPower', () => {
    render(<ReadBack mode="direct" draft={providerDirection()} onConfirm={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByTestId('read-back-money-power')).toHaveTextContent(/can never move money/i);
    cleanup();
    render(<ReadBack mode="direct" draft={treasuryDirection()} onConfirm={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByTestId('read-back-money-power')).toHaveTextContent(/can move money/i);
  });

  it('a cannot-move-money role shows NO recipient input', () => {
    render(<ReadBack mode="direct" draft={providerDirection()} onConfirm={vi.fn()} onBack={vi.fn()} />);
    expect(screen.queryByTestId('rb-recipient')).not.toBeInTheDocument();
    expect(screen.getByTestId('read-back-no-money-note')).toBeInTheDocument();
  });

  it('recipient is blank-required for a can-move-money role and passed OUT-OF-BAND', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ReadBack mode="direct" draft={treasuryDirection()} onConfirm={onConfirm} onBack={vi.fn()} />);
    expect(screen.getByTestId('rb-recipient')).toHaveValue('');
    await user.click(screen.getByTestId('read-back-confirm'));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/never guessed/i);
    await user.type(screen.getByTestId('rb-recipient'), RECIPIENT);
    await user.click(screen.getByTestId('read-back-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const [edited, recipient] = onConfirm.mock.calls[0]!;
    expect(recipient).toBe(RECIPIENT);
    // Never smuggled into the quarantined draft.
    expect(JSON.stringify(edited)).not.toContain(RECIPIENT);
  });

  it('shows a suggestedPolicy read-only with the time-locked disclosure (never armed here)', () => {
    render(<ReadBack mode="direct" draft={treasuryDirection()} onConfirm={vi.fn()} onBack={vi.fn()} />);
    const block = screen.getByTestId('read-back-suggested-policy');
    expect(block).toHaveTextContent(/not applied/i);
    expect(block).toHaveTextContent(/time-locked step/i);
  });

  it('a goalPatch never renders a money-authority key even if one leaks in', () => {
    render(
      <ReadBack
        mode="direct"
        draft={providerDirection({ goalPatch: { serviceSpec: 'x', recipient: RECIPIENT, feeToken: '0xabc' } })}
        onConfirm={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('rb-patch-recipient')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rb-patch-feeToken')).not.toBeInTheDocument();
    expect(screen.getByTestId('rb-patch-serviceSpec')).toBeInTheDocument();
  });

  it('SOURCE never contains dangerouslySetInnerHTML (quarantine)', () => {
    const src = readFileSync(resolve(process.cwd(), 'components/create/ReadBack.tsx'), 'utf8');
    expect(src).not.toMatch(/dangerouslySetInnerHTML\s*=/);
  });
});
