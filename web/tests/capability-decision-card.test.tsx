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

// ── SE-8: governed BRIDGE calls decode to human terms from SERVER-verified bytes ──
const ACCOUNT = '0x' + 'c'.repeat(40);
const BRIDGE = '0x4200000000000000000000000000000000000010';
const word = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0');

// bridgeETHTo(to=ACCOUNT, minGasLimit=200000, extraData="") — canonical, extraData forced empty.
const BRIDGE_ETH: CapabilityRequestRow = {
  ...REQUEST,
  callValue: '5000000000000000',
  callData: '0xe11013dd' + word(ACCOUNT) + word('30d40') + word('60') + word('0'),
  decoded: {
    ...REQUEST.decoded,
    target: BRIDGE as `0x${string}`,
    selector: '0xe11013dd',
    signature: 'function bridgeETHTo(address to, uint32 minGasLimit, bytes extraData)',
    value: '5000000000000000',
    humanReadable: 'bridge 5000000000000000 base-units on 0x4200…0010 → 0xcccc…cccc',
    novelty: ['bridge'],
  },
  novelty: ['bridge'],
};

const TOKEN = '0x' + 'd'.repeat(40);
// bridgeERC20To(localToken=TOKEN, remoteToken=TOKEN, to=ACCOUNT, amount=100000000, minGasLimit, extraData="").
const BRIDGE_ERC20: CapabilityRequestRow = {
  ...BRIDGE_ETH,
  callValue: '0',
  callData:
    '0x540abf73' + word(TOKEN) + word(TOKEN) + word(ACCOUNT) + word('5f5e100') + word('30d40') + word('c0') + word('0'),
  decoded: { ...BRIDGE_ETH.decoded, selector: '0x540abf73', value: '0' },
};

describe('CapabilityDecisionCard', () => {
  it('decodes bridgeETHTo from the server-verified bytes to human terms, still UNVERIFIED', () => {
    render(<CapabilityDecisionCard request={BRIDGE_ETH} accountAddr={ACCOUNT} onApproveOnce={vi.fn()} onAlwaysAllow={vi.fn()} onDeny={vi.fn()} />);
    expect(screen.getByTestId('jit-intent').textContent).toBe(
      'bridge 5000000000000000 base-units via bridge 0x4200…0010 to your same-address account on the destination chain',
    );
    expect(screen.getAllByText(/UNVERIFIED/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/It had to ask because it involves a bridge/i)).toBeInTheDocument();
  });

  it('decodes bridgeERC20To (token + amount) and pins the same-address recipient', () => {
    render(<CapabilityDecisionCard request={BRIDGE_ERC20} accountAddr={ACCOUNT} onApproveOnce={vi.fn()} onAlwaysAllow={vi.fn()} onDeny={vi.fn()} />);
    expect(screen.getByTestId('jit-intent').textContent).toBe(
      'bridge 100000000 base-units of token 0xdddd…dddd via bridge 0x4200…0010 to your same-address account on the destination chain',
    );
  });

  it('names a non-self bridge recipient by short address (no same-address claim)', () => {
    render(<CapabilityDecisionCard request={BRIDGE_ETH} accountAddr={'0x' + 'e'.repeat(40)} onApproveOnce={vi.fn()} onAlwaysAllow={vi.fn()} onDeny={vi.fn()} />);
    expect(screen.getByTestId('jit-intent').textContent).toContain('to 0xcccc…cccc');
    expect(screen.getByTestId('jit-intent').textContent).not.toContain('same-address');
  });

  it('falls back to the server humanReadable for non-bridge selectors and non-canonical bridge bytes', () => {
    // Unknown/non-bridge selector: unchanged fallback.
    const { unmount } = render(<CapabilityDecisionCard request={REQUEST} accountAddr={ACCOUNT} onApproveOnce={vi.fn()} onAlwaysAllow={vi.fn()} onDeny={vi.fn()} />);
    expect(screen.getByTestId('jit-intent').textContent).toBe(REQUEST.decoded.humanReadable);
    unmount();
    // Bridge selector but truncated calldata: never guess — fall back.
    const bad = { ...BRIDGE_ETH, callData: '0xe11013dd' + word(ACCOUNT) };
    render(<CapabilityDecisionCard request={bad} accountAddr={ACCOUNT} onApproveOnce={vi.fn()} onAlwaysAllow={vi.fn()} onDeny={vi.fn()} />);
    expect(screen.getByTestId('jit-intent').textContent).toBe(BRIDGE_ETH.decoded.humanReadable);
  });

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
