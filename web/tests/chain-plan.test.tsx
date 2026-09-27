// File: web/tests/chain-plan.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { ChainPlanEditor } from '@/components/cockpit/ChainPlanEditor';
import { ChainView } from '@/components/cockpit/ChainView';
import type { Chain, ChainStep, Delegation } from '@/lib/types';

const CANDS = [
  { id: 'a1', label: 'Analyst' },
  { id: 't1', label: 'Trader' },
];

/** Test harness: renders the editor with controlled state + a "read" of the plan. */
function Harness({ onPlan }: { onPlan: (p: ChainStep[]) => void }) {
  const [plan, setPlan] = useState<ChainStep[]>([]);
  return (
    <div>
      <ChainPlanEditor candidates={CANDS} maxDepth={3} maxEligiblePerHop={3} value={plan} onChange={(p) => { setPlan(p); onPlan(p); }} />
    </div>
  );
}

describe('ChainPlanEditor', () => {
  it('is collapsed by default (no cockpit crowding) and opens on demand', async () => {
    const user = userEvent.setup();
    render(<Harness onPlan={vi.fn()} />);
    expect(screen.queryByTestId('chain-plan-editor')).toBeNull();
    await user.click(screen.getByTestId('chain-plan-open'));
    expect(screen.getByTestId('chain-plan-editor')).toBeInTheDocument();
  });

  it('builds a hop with an owner-selected target + intent (never pre-selected)', async () => {
    const user = userEvent.setup();
    let last: ChainStep[] = [];
    render(<Harness onPlan={(p) => (last = p)} />);
    await user.click(screen.getByTestId('chain-plan-open')); // opens + adds hop 0
    // No target is pre-selected.
    expect(screen.getByTestId('chain-target-0-a1').getAttribute('aria-pressed')).toBe('false');
    await user.click(screen.getByTestId('chain-target-0-t1'));
    await user.type(screen.getByTestId('chain-intent-0'), 'rebalance');
    expect(last[0]?.eligibleTargetIds).toEqual(['t1']);
    expect(last[0]?.directedIntent).toBe('rebalance');
  });

  it('shows a link-first message when the owner has no linked capabilities', () => {
    render(<ChainPlanEditor candidates={[]} maxDepth={3} maxEligiblePerHop={3} value={[]} onChange={vi.fn()} />);
    expect(screen.getByTestId('chain-plan-empty')).toBeInTheDocument();
  });
});

describe('ChainView', () => {
  it('renders a chain-ordered timeline with per-hop status + quarantined intent', () => {
    const chain: Chain = {
      id: 'c1',
      ownerAddr: '0xowner',
      originAgentId: 'o1',
      directionId: 'd1',
      plan: [
        { eligibleTargetIds: ['a1'], directedIntent: 'analyze' },
        { eligibleTargetIds: ['t1'], directedIntent: 'trade' },
      ],
      status: 'running',
      nextHop: 1,
      path: ['o1', 'a1'],
      currentDelegationId: 'dg1',
      createdAt: '2026-09-27T00:00:00Z',
      updatedAt: '2026-09-27T00:00:00Z',
    };
    const hops: Delegation[] = [
      { id: 'dg1', linkId: 'l1', fromAgentId: 'o1', toAgentId: 'a1', kind: 'chain.handoff', payload: {}, status: 'completed', createdAt: '', expiresAt: '' },
    ];
    render(<ChainView chain={chain} hops={hops} agentNames={{ o1: 'Origin', a1: 'Analyst', t1: 'Trader' }} />);
    expect(screen.getByTestId('chain-status')).toHaveTextContent('Running');
    expect(within(screen.getByTestId('chain-view-hop-0')).getByTestId('chain-view-hop-status-0')).toHaveTextContent('completed');
    expect(screen.getByTestId('chain-view-intent-0')).toHaveTextContent('analyze');
    // Step 2 not started yet.
    expect(screen.getByTestId('chain-view-hop-status-1')).toHaveTextContent('not yet started');
  });
});
