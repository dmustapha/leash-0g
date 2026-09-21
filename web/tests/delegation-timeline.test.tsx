// File: web/tests/delegation-timeline.test.tsx
// Delegation timeline rendering (statuses, results, per-side names) + the live SSE merge
// helper applyDelegationEvent (update, stub-insert, terminal no-regress).
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DelegationTimeline } from '@/components/links/DelegationTimeline';
import { applyDelegationEvent } from '@/lib/delegations';
import type { Delegation, DelegationEvent } from '@/lib/types';

const NAMES = { a1: 'Watcher', a2: 'Executor' };

function delegation(over: Partial<Delegation> = {}): Delegation {
  return {
    id: 'd1',
    linkId: 'l1',
    fromAgentId: 'a1',
    toAgentId: 'a2',
    kind: 'transfer.request',
    payload: { amountWei: '1' },
    status: 'pending',
    createdAt: '2026-09-20T12:00:00.000Z',
    expiresAt: '2026-09-20T12:10:00.000Z',
    ...over,
  };
}

function event(over: Partial<DelegationEvent> = {}): DelegationEvent {
  return {
    type: 'delegation',
    delegationId: 'd1',
    linkId: 'l1',
    status: 'accepted',
    kind: 'transfer.request',
    counterpartyAgentId: 'a2',
    direction: 'outbound',
    ts: '2026-09-20T12:01:00.000Z',
    ...over,
  };
}

describe('DelegationTimeline', () => {
  it('renders plain-language statuses, kind, and per-side agent names', () => {
    render(
      <DelegationTimeline
        delegations={[
          delegation(),
          delegation({ id: 'd2', status: 'declined' }),
          delegation({ id: 'd3', status: 'completed', result: { txHash: '0x' + 'a'.repeat(64) } }),
        ]}
        agentNames={NAMES}
      />,
    );
    expect(screen.getByTestId('delegation-d1')).toHaveTextContent('waiting for the other agent');
    expect(screen.getByTestId('delegation-d1')).toHaveTextContent('Watcher asked Executor');
    expect(screen.getByTestId('delegation-d1')).toHaveTextContent('transfer.request');
    expect(screen.getByTestId('delegation-d2')).toHaveTextContent('you declined');
    expect(screen.getByTestId('delegation-d3')).toHaveTextContent('done');
  });

  it('links a txHash result to the explorer, renders other results as code', () => {
    render(
      <DelegationTimeline
        delegations={[
          delegation({ id: 'd3', status: 'completed', result: { txHash: '0x' + 'a'.repeat(64) } }),
          delegation({ id: 'd4', status: 'failed', result: { error: 'over policy' } }),
        ]}
        agentNames={NAMES}
      />,
    );
    expect(screen.getByTestId('delegation-tx-d3')).toHaveAttribute(
      'href',
      `https://chainscan-galileo.0g.ai/tx/0x${'a'.repeat(64)}`,
    );
    expect(screen.getByTestId('delegation-result-d4')).toHaveTextContent('over policy');
  });

  it('shows the empty state', () => {
    render(<DelegationTimeline delegations={[]} agentNames={{}} />);
    expect(screen.getByTestId('delegation-timeline')).toHaveTextContent(/no handoffs yet/i);
  });

  it('merges a live SSE event: status update renders without a refetch', () => {
    const merged = applyDelegationEvent([delegation()], event({ status: 'completed' }));
    render(<DelegationTimeline delegations={merged} agentNames={NAMES} />);
    expect(screen.getByTestId('delegation-d1')).toHaveTextContent('done');
  });
});

describe('applyDelegationEvent', () => {
  it('updates the matching row status', () => {
    const out = applyDelegationEvent([delegation()], event({ status: 'accepted' }));
    expect(out[0]?.status).toBe('accepted');
  });

  it('prepends a stub row for an unknown delegation id', () => {
    const out = applyDelegationEvent([delegation()], event({ delegationId: 'd9', status: 'pending', direction: 'inbound', counterpartyAgentId: 'a1' }));
    expect(out).toHaveLength(2);
    expect(out[0]?.id).toBe('d9');
    expect(out[0]?.fromAgentId).toBe('a1');
  });

  it('never regresses a terminal status', () => {
    const out = applyDelegationEvent([delegation({ status: 'completed' })], event({ status: 'pending' }));
    expect(out[0]?.status).toBe('completed');
  });
});
