// File: web/tests/links.test.tsx
// Link create form validation + plain-language mode explanation + paused/revoked target
// warning, and the link list's manage actions.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LinkCreateForm } from '@/components/links/LinkCreateForm';
import { LinkList } from '@/components/links/LinkList';
import type { AgentSummary, Link } from '@/lib/types';

function agent(id: string, name: string, status: AgentSummary['status'] = 'active'): AgentSummary {
  return {
    agentId: id,
    name,
    status,
    accountAddr: '0x1111111111111111111111111111111111111111',
    sessionKeyAddr: '0x2222222222222222222222222222222222222222',
    accountBalanceWei: '0',
    createdAt: '2026-09-20T12:00:00.000Z',
  };
}

const AGENTS = [agent('a1', 'Watcher'), agent('a2', 'Executor'), agent('a3', 'Dead', 'revoked')];

function link(over: Partial<Link> = {}): Link {
  return {
    id: 'l1',
    ownerAddr: '0x3333333333333333333333333333333333333333',
    fromAgentId: 'a1',
    toAgentId: 'a2',
    mode: 'auto',
    status: 'active',
    createdAt: '2026-09-20T12:00:00.000Z',
    delegationCount: 3,
    ...over,
  };
}

describe('LinkCreateForm', () => {
  it('explains both modes in plain language', () => {
    render(<LinkCreateForm agents={AGENTS} onCreate={vi.fn()} />);
    expect(screen.getByText(/handoffs flow immediately/i)).toBeInTheDocument();
    expect(screen.getByText(/waits for your approval/i)).toBeInTheDocument();
  });

  it('requires both agents to be picked', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<LinkCreateForm agents={AGENTS} onCreate={onCreate} />);
    await user.click(screen.getByTestId('create-link-btn'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/pick both agents/i);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('rejects linking an agent to itself', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<LinkCreateForm agents={AGENTS} onCreate={onCreate} />);
    await user.selectOptions(screen.getByLabelText(/^From \(/), 'a1');
    await user.selectOptions(screen.getByLabelText(/^To \(/), 'a1');
    await user.click(screen.getByTestId('create-link-btn'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot hand work to itself/i);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('warns inline when the target agent is revoked', async () => {
    const user = userEvent.setup();
    render(<LinkCreateForm agents={AGENTS} onCreate={vi.fn()} />);
    await user.selectOptions(screen.getByLabelText(/^To \(/), 'a3');
    expect(screen.getByTestId('link-target-warning')).toHaveTextContent(/revoked/i);
  });

  it('submits from/to/mode', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<LinkCreateForm agents={AGENTS} onCreate={onCreate} />);
    await user.selectOptions(screen.getByLabelText(/^From \(/), 'a1');
    await user.selectOptions(screen.getByLabelText(/^To \(/), 'a2');
    await user.click(screen.getByRole('radio', { name: /supervised/i }));
    await user.click(screen.getByTestId('create-link-btn'));
    expect(onCreate).toHaveBeenCalledWith({ fromAgentId: 'a1', toAgentId: 'a2', mode: 'supervised' });
  });
});

describe('LinkList', () => {
  const names = { a1: 'Watcher', a2: 'Executor' };

  it('renders status, mode, delegation count, and per-side names', () => {
    render(<LinkList links={[link()]} agentNames={names} onAction={vi.fn()} onModeChange={vi.fn()} />);
    const row = screen.getByTestId('link-row-l1');
    expect(row).toHaveTextContent('Watcher → Executor');
    expect(row).toHaveTextContent('active');
    expect(row).toHaveTextContent('automatic');
    expect(row).toHaveTextContent('3 handoffs');
  });

  it('shows the empty state', () => {
    render(<LinkList links={[]} agentNames={{}} onAction={vi.fn()} onModeChange={vi.fn()} />);
    expect(screen.getByTestId('links-empty')).toBeInTheDocument();
  });

  it('pause/resume/remove and mode toggle bubble up', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn().mockResolvedValue(undefined);
    const onModeChange = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <LinkList links={[link()]} agentNames={names} onAction={onAction} onModeChange={onModeChange} />,
    );
    await user.click(screen.getByTestId('pause-link-l1'));
    expect(onAction).toHaveBeenCalledWith('l1', 'pause');
    await user.click(screen.getByTestId('toggle-mode-l1'));
    expect(onModeChange).toHaveBeenCalledWith('l1', 'supervised');
    await user.click(screen.getByTestId('remove-link-l1'));
    expect(onAction).toHaveBeenCalledWith('l1', 'remove');

    rerender(
      <LinkList links={[link({ status: 'paused' })]} agentNames={names} onAction={onAction} onModeChange={onModeChange} />,
    );
    await user.click(screen.getByTestId('resume-link-l1'));
    expect(onAction).toHaveBeenCalledWith('l1', 'resume');
  });

  it('removed links have no actions', () => {
    render(<LinkList links={[link({ status: 'removed' })]} agentNames={names} onAction={vi.fn()} onModeChange={vi.fn()} />);
    expect(screen.queryByTestId('pause-link-l1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('remove-link-l1')).not.toBeInTheDocument();
  });
});
