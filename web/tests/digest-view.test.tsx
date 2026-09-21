// File: web/tests/digest-view.test.tsx
// Digest view (spec §3c): per-agent cards with the exact "balance change" label (signed, '—'
// when null), totals, per-link outcomes, mark-caught-up, plain-language empty state.
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Digest } from '@/lib/types';
import { DigestView } from '@/components/digest/DigestView';

function digest(over: Partial<Digest> = {}): Digest {
  return {
    generatedAt: new Date().toISOString(),
    since: new Date(Date.now() - 86_400_000).toISOString(),
    agents: [
      {
        agentId: 'agent-1',
        name: 'Treasury helper',
        status: 'running',
        spendWei: '20000000000000000', // 0.02
        balanceWei: '230000000000000000',
        balanceChangeWei: '-20000000000000000',
        actions: 2,
        blocks: 1,
        modifies: 0,
        approvals: { approved: 1, denied: 0, expired: 0 },
        delegationsTerminal: { failed: 1 },
      },
      {
        agentId: 'agent-2',
        name: 'Executor',
        status: 'running',
        spendWei: '0',
        balanceWei: '100000000000000000',
        balanceChangeWei: null, // no baseline yet — honest '—'
        actions: 0,
        blocks: 0,
        modifies: 0,
        approvals: { approved: 0, denied: 0, expired: 0 },
        delegationsTerminal: {},
      },
    ],
    links: [{ linkId: 'link-1', fromAgentId: 'agent-1', toAgentId: 'agent-2', byStatus: { completed: 3, failed: 1 } }],
    totals: { spendWei: '20000000000000000', actions: 2, decisions: 1 },
    empty: false,
    ...over,
  };
}

describe('DigestView', () => {
  it('labels the delta exactly "balance change", signed, and — when null', () => {
    render(<DigestView digest={digest()} onMark={vi.fn()} />);
    const a1 = screen.getByTestId('digest-agent-agent-1');
    expect(within(a1).getByText('Balance change')).toBeInTheDocument();
    expect(within(a1).getByTestId('balance-change')).toHaveTextContent('-0.02 0G');
    const a2 = screen.getByTestId('digest-agent-agent-2');
    expect(within(a2).getByTestId('balance-change')).toHaveTextContent('—');
  });

  it('shows spend, activity counts, per-link outcomes, and totals', () => {
    render(<DigestView digest={digest()} onMark={vi.fn()} />);
    const a1 = screen.getByTestId('digest-agent-agent-1');
    expect(within(a1).getByText('0.02 0G')).toBeInTheDocument();
    expect(a1).toHaveTextContent('2 payments · 1 blocked · 0 modified');
    expect(a1).toHaveTextContent('1 approved, 0 denied, 0 expired');
    expect(a1).toHaveTextContent('handoffs ended: 1 failed');
    expect(screen.getByTestId('digest-link-link-1')).toHaveTextContent('3 completed, 1 failed');
    expect(screen.getByTestId('digest-totals')).toHaveTextContent('0.02 0G spent');
    expect(screen.getByTestId('digest-totals')).toHaveTextContent('1 decision from you');
  });

  it('mark caught up calls onMark', async () => {
    const user = userEvent.setup();
    const onMark = vi.fn().mockResolvedValue(undefined);
    render(<DigestView digest={digest()} onMark={onMark} />);
    await user.click(screen.getByTestId('mark-caught-up-btn'));
    expect(onMark).toHaveBeenCalled();
  });

  it('empty digest shows the plain-language empty state', () => {
    render(<DigestView digest={digest({ empty: true, agents: [], links: [] })} onMark={vi.fn()} />);
    expect(screen.getByTestId('digest-empty')).toHaveTextContent('Nothing new since you last looked.');
  });
});
