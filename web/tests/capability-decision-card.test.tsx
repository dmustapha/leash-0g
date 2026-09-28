// File: web/tests/capability-decision-card.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CapabilityDecisionCard } from '@/components/cockpit/CapabilityDecisionCard';
import type { CapabilityRequestRow } from '@/lib/types';

const REQUEST: CapabilityRequestRow = {
  id: 'req-1',
  callHash: ('0x' + '1'.repeat(64)) as `0x${string}`,
  status: 'pending',
  approvalId: 'apr-cap-1',
  novelty: ['new_target', 'over_cap'],
  decoded: {
    label: 'UNVERIFIED',
    target: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    selector: '0x38ed1739',
    signature: 'function swap(address,address,uint256,uint256,address,uint256)',
    value: '0',
    humanReadable: 'Swap 100 USDC for at least 99 DAI on the router',
    novelty: ['new_target', 'over_cap'],
  },
};

// Deliberate XSS payload proving we NEVER parse quarantined text as markup.
const XSS: CapabilityRequestRow = {
  ...REQUEST,
  decoded: { ...REQUEST.decoded, humanReadable: '<img src=x onerror="alert(1)">hack' },
};

describe('CapabilityDecisionCard', () => {
  it('renders decoded intent labeled UNVERIFIED as plain text (never markup)', () => {
    const { container } = render(<CapabilityDecisionCard request={XSS} onApproveOnce={vi.fn()} onAlwaysAllow={vi.fn()} onDeny={vi.fn()} />);
    // The literal string is present verbatim → it was rendered as text, not HTML.
    expect(screen.getByTestId('jit-intent').textContent).toContain('<img src=x onerror="alert(1)">hack');
    // No injected <img> element exists in the DOM.
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getAllByText(/UNVERIFIED/i).length).toBeGreaterThan(0);
  });

  it('shows novelty reasons in plain language', () => {
    render(<CapabilityDecisionCard request={REQUEST} onApproveOnce={vi.fn()} onAlwaysAllow={vi.fn()} onDeny={vi.fn()} />);
    expect(screen.getByText(/a contract it has never used before/i)).toBeInTheDocument();
    expect(screen.getByText(/more than its per-call limit/i)).toBeInTheDocument();
  });

  it('approve-once calls onApproveOnce with the callHash', async () => {
    const user = userEvent.setup();
    const onApproveOnce = vi.fn().mockResolvedValue(undefined);
    render(<CapabilityDecisionCard request={REQUEST} onApproveOnce={onApproveOnce} onAlwaysAllow={vi.fn()} onDeny={vi.fn()} />);
    await user.click(screen.getByTestId('jit-approve-once'));
    await waitFor(() => expect(onApproveOnce).toHaveBeenCalledTimes(1));
    expect(onApproveOnce).toHaveBeenCalledWith(REQUEST.callHash);
  });

  it('always-allow requires explicit confirmation and passes a rule the owner confirmed', async () => {
    const user = userEvent.setup();
    const onAlwaysAllow = vi.fn().mockResolvedValue(undefined);
    render(<CapabilityDecisionCard request={REQUEST} onApproveOnce={vi.fn()} onAlwaysAllow={onAlwaysAllow} onDeny={vi.fn()} />);
    // Opening always-allow must reveal the rule to confirm — never a silent pre-approve.
    await user.click(screen.getByTestId('jit-always-allow'));
    expect(await screen.findByTestId('jit-always-allow-confirm')).toBeInTheDocument();
    await user.click(screen.getByTestId('jit-always-allow-confirm'));
    await waitFor(() => expect(onAlwaysAllow).toHaveBeenCalledTimes(1));
    const rule = onAlwaysAllow.mock.calls[0]![0];
    expect(rule.target).toBe(REQUEST.decoded.target);
    expect(rule.selector).toBe(REQUEST.decoded.selector);
  });

  it('deny calls onDeny with no transaction', async () => {
    const user = userEvent.setup();
    const onDeny = vi.fn().mockResolvedValue(undefined);
    render(<CapabilityDecisionCard request={REQUEST} onApproveOnce={vi.fn()} onAlwaysAllow={vi.fn()} onDeny={onDeny} />);
    await user.click(screen.getByTestId('jit-deny'));
    await waitFor(() => expect(onDeny).toHaveBeenCalledTimes(1));
  });
});
