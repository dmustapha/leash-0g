// File: web/tests/fleet-list.test.tsx
// Fleet list: rows render name/status/balance, empty state, and load-more paging.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FleetList } from '@/components/fleet/FleetList';
import type { AgentSummary } from '@/lib/types';

function agent(id: string, name: string, over: Partial<AgentSummary> = {}): AgentSummary {
  return {
    agentId: id,
    name,
    status: 'active',
    accountAddr: '0x1111111111111111111111111111111111111111',
    sessionKeyAddr: '0x2222222222222222222222222222222222222222',
    accountBalanceWei: '250000000000000000',
    createdAt: '2026-09-20T12:00:00.000Z',
    ...over,
  };
}

describe('FleetList', () => {
  it('renders one row per agent with name, status, and 0G balance', () => {
    render(
      <FleetList
        agents={[agent('a1', 'Treasury helper'), agent('a2', 'Watcher', { status: 'revoked', accountBalanceWei: '0' })]}
        hasMore={false}
        onLoadMore={vi.fn()}
      />,
    );
    const row1 = screen.getByTestId('fleet-row-a1');
    expect(row1).toHaveTextContent('Treasury helper');
    expect(row1).toHaveTextContent('active');
    expect(row1).toHaveTextContent('0.25 0G');
    expect(row1).toHaveAttribute('href', '/agents/a1');
    const row2 = screen.getByTestId('fleet-row-a2');
    expect(row2).toHaveTextContent('revoked');
    expect(row2).toHaveTextContent('0 0G');
  });

  it('shows the empty state with a create call to action', () => {
    render(<FleetList agents={[]} hasMore={false} onLoadMore={vi.fn()} />);
    expect(screen.getByTestId('fleet-empty')).toHaveTextContent(/no agents yet/i);
    expect(screen.getByRole('link', { name: /create your agent/i })).toHaveAttribute('href', '/create');
  });

  it('shows Load more only when a next cursor exists and fires onLoadMore', async () => {
    const user = userEvent.setup();
    const onLoadMore = vi.fn();
    const { rerender } = render(
      <FleetList agents={[agent('a1', 'One')]} hasMore onLoadMore={onLoadMore} />,
    );
    await user.click(screen.getByTestId('fleet-load-more'));
    expect(onLoadMore).toHaveBeenCalledOnce();
    rerender(<FleetList agents={[agent('a1', 'One')]} hasMore={false} onLoadMore={onLoadMore} />);
    expect(screen.queryByTestId('fleet-load-more')).not.toBeInTheDocument();
  });

  it('disables Load more while the next page is loading', () => {
    render(<FleetList agents={[agent('a1', 'One')]} hasMore loadingMore onLoadMore={vi.fn()} />);
    expect(screen.getByTestId('fleet-load-more')).toBeDisabled();
  });
});
