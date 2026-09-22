// File: web/tests/inbox.test.tsx
// Inbox surfaces (spec §3c): rendering by kind, filters, decision cards on the SAME approval
// rails, limit_hit adjust deep-link + decoded copy, dismiss, coalesced counters, mark-all-read.
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Alert } from '@/lib/types';
import { AlertCard } from '@/components/inbox/AlertCard';
import { InboxView } from '@/components/inbox/InboxView';

function alert(over: Partial<Alert>): Alert {
  return {
    id: 'al-1',
    ownerAddr: '0x3333333333333333333333333333333333333333',
    class: 'info',
    kind: 'revoked',
    status: 'unread',
    summary: 'Something happened',
    refs: {},
    count: 1,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

const APPROVAL_ALERT = alert({
  id: 'al-appr',
  agentId: 'agent-1',
  class: 'decision',
  kind: 'approval_required',
  summary: 'Treasury helper wants to send 0.02 0G — approve?',
  refs: { approvalId: 'apr-1' },
});

const LIMIT_ALERT = alert({
  id: 'al-limit',
  agentId: 'agent-1',
  class: 'decision',
  kind: 'limit_hit',
  summary: 'Treasury helper hit its spending window cap.',
  refs: { errorName: 'OverWindowCap', boundaryClearsAtUnix: Math.floor(Date.now() / 1000) + 2460 },
});

describe('AlertCard', () => {
  it('approval_required: approve rides the same approval rails and has NO dismiss', async () => {
    const user = userEvent.setup();
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<AlertCard alert={APPROVAL_ALERT} onDecide={onDecide} onDismiss={vi.fn()} />);
    expect(screen.queryByTestId('alert-dismiss-btn')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('alert-approve-btn'));
    expect(onDecide).toHaveBeenCalledWith('apr-1', 'approve');
  });

  it('approval_required: agent intent renders labeled unverified, quarantined from verified facts', () => {
    render(
      <AlertCard
        alert={{ ...APPROVAL_ALERT, refs: { approvalId: 'apr-1', agentIntent: 'Rebalancing into treasury reserve' } }}
        onDecide={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const block = screen.getByTestId('agent-intent');
    expect(block).toHaveTextContent(/unverified/i);
    expect(block).toHaveTextContent('Rebalancing into treasury reserve');
  });

  it('approval_required: no intent block when the agent gave no purpose', () => {
    render(<AlertCard alert={APPROVAL_ALERT} onDecide={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.queryByTestId('agent-intent')).not.toBeInTheDocument();
  });

  it('approval_required: resolved alert shows the outcome and no buttons', () => {
    render(
      <AlertCard
        alert={{ ...APPROVAL_ALERT, status: 'resolved', resolution: 'approve', resolvedVia: 'telegram' }}
        onDecide={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByTestId('alert-resolution')).toHaveTextContent('Approved · via Telegram');
    expect(screen.queryByTestId('alert-approve-btn')).not.toBeInTheDocument();
  });

  it('limit_hit: plain decoded copy, countdown, adjust deep-link to the policy panel, dismissible', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn().mockResolvedValue(undefined);
    render(<AlertCard alert={LIMIT_ALERT} onDecide={vi.fn()} onDismiss={onDismiss} />);
    expect(screen.getByTestId('decoded-plain')).toHaveTextContent(
      'That would go over the spending window cap',
    );
    expect(screen.getByTestId('limit-countdown')).toHaveTextContent(/Resets in/);
    // Raw error name only behind the disclosure — plain language on the surface.
    expect(screen.getByText('OverWindowCap')).toBeInTheDocument();
    expect(screen.getByTestId('alert-adjust-link')).toHaveAttribute(
      'href',
      '/agents/agent-1#policy-panel',
    );
    await user.click(screen.getByTestId('alert-dismiss-btn'));
    expect(onDismiss).toHaveBeenCalledWith('al-limit');
  });

  it('limit_hit on SessionExpired steers to re-arm instead of the policy panel', () => {
    render(
      <AlertCard
        alert={{ ...LIMIT_ALERT, refs: { errorName: 'SessionExpired' } }}
        onDecide={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const link = screen.getByTestId('alert-adjust-link');
    expect(link).toHaveTextContent('Re-arm the agent');
    expect(link).toHaveAttribute('href', '/agents/agent-1');
  });

  it('revoke_failed: steer CTA links to the agent page', () => {
    render(
      <AlertCard
        alert={alert({ id: 'al-rf', kind: 'revoke_failed', agentId: 'agent-2' })}
        onDecide={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByTestId('alert-steer-link')).toHaveAttribute('href', '/agents/agent-2');
  });

  it('coalesced info alert shows ×N', () => {
    render(
      <AlertCard
        alert={alert({ id: 'al-err', kind: 'runtime_error', count: 4 })}
        onDecide={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByTestId('alert-count')).toHaveTextContent('×4');
  });
});

describe('InboxView', () => {
  const ALERTS = [APPROVAL_ALERT, LIMIT_ALERT, alert({ id: 'al-info', kind: 'revoked', agentId: 'agent-2' })];
  const AGENTS = [
    { agentId: 'agent-1', name: 'Treasury helper' },
    { agentId: 'agent-2', name: 'Executor' },
  ];

  it('renders all alerts with the unread pill', () => {
    render(
      <InboxView alerts={ALERTS} unread={3} agents={AGENTS} onDecide={vi.fn()} onDismiss={vi.fn()} onMarkAllRead={vi.fn()} />,
    );
    expect(screen.getByTestId('inbox-unread-pill')).toHaveTextContent('3 unread');
    expect(within(screen.getByTestId('inbox-list')).getAllByRole('article')).toHaveLength(3);
  });

  it('filters by kind and by agent', async () => {
    const user = userEvent.setup();
    render(
      <InboxView alerts={ALERTS} unread={3} agents={AGENTS} onDecide={vi.fn()} onDismiss={vi.fn()} onMarkAllRead={vi.fn()} />,
    );
    await user.selectOptions(screen.getByTestId('filter-kind'), 'limit_hit');
    expect(within(screen.getByTestId('inbox-list')).getAllByRole('article')).toHaveLength(1);
    expect(screen.getByTestId('alert-al-limit')).toBeInTheDocument();

    await user.selectOptions(screen.getByTestId('filter-kind'), 'all');
    await user.selectOptions(screen.getByTestId('filter-agent'), 'agent-2');
    expect(within(screen.getByTestId('inbox-list')).getAllByRole('article')).toHaveLength(1);
    expect(screen.getByTestId('alert-al-info')).toBeInTheDocument();
  });

  it('filters by class (decision vs info)', async () => {
    const user = userEvent.setup();
    render(
      <InboxView alerts={ALERTS} unread={3} agents={AGENTS} onDecide={vi.fn()} onDismiss={vi.fn()} onMarkAllRead={vi.fn()} />,
    );
    await user.selectOptions(screen.getByTestId('filter-class'), 'decision');
    expect(within(screen.getByTestId('inbox-list')).getAllByRole('article')).toHaveLength(2);
  });

  it('mark all read fires the callback; empty state is plain language', async () => {
    const user = userEvent.setup();
    const onMarkAllRead = vi.fn().mockResolvedValue(undefined);
    render(
      <InboxView alerts={[]} unread={0} agents={[]} onDecide={vi.fn()} onDismiss={vi.fn()} onMarkAllRead={onMarkAllRead} />,
    );
    expect(screen.getByTestId('inbox-empty')).toBeInTheDocument();
    expect(screen.getByTestId('inbox-caught-up-pill')).toHaveTextContent('All caught up');
    await user.click(screen.getByTestId('mark-all-read-btn'));
    expect(onMarkAllRead).toHaveBeenCalled();
  });
});
