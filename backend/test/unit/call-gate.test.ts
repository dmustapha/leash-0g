import { describe, it, expect } from 'vitest';
import { encodeFunctionData, parseAbi, toFunctionSelector } from 'viem';
import { classifyIntendedCall } from '../../src/gateway/call-gate.js';
import { ruleKey, type CallRule, type GrantState } from '../../src/governed-call/index.js';

const SELF = '0x' + '55'.repeat(20);
const ROUTER = '0x' + 'dd'.repeat(20);
const TOKEN = '0x' + 'cc'.repeat(20);
const OTHER = '0x' + 'bb'.repeat(20);

const erc20 = parseAbi(['function approve(address,uint256)', 'function transfer(address,uint256)']);
const multicallAbi = parseAbi(['function multicall(bytes[] data)']);
const enc = (abi: readonly unknown[], fn: string, args: readonly unknown[]): string =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  encodeFunctionData({ abi: abi as any, functionName: fn as any, args: args as any });

const approveRule: CallRule = {
  target: TOKEN,
  selector: toFunctionSelector('function approve(address,uint256)'),
  recipientMode: 'self',
  spenderSet: [ROUTER],
  perCallCap: '100',
  windowCapCall: '500',
};
const multicallRule: CallRule = {
  target: TOKEN,
  selector: toFunctionSelector('function multicall(bytes[])'),
  recipientMode: 'self',
  spenderSet: [],
  perCallCap: '0',
  windowCapCall: '0',
};

function grant(rules: CallRule[]): GrantState {
  return {
    rules: new Map(rules.map((r) => [ruleKey(r.target, r.selector), r])),
    budgets: new Map([[TOKEN.toLowerCase(), '1000']]),
    allowlist: new Set<string>(),
  };
}

describe('classifyIntendedCall — non-wrapper passthrough', () => {
  it('in-envelope approve → L1', () => {
    const r = classifyIntendedCall(TOKEN, 0n, enc(erc20, 'approve', [ROUTER, 10n]), grant([approveRule]), SELF);
    expect(r.classification).toEqual({ lane: 'l1', reason: 'in_envelope' });
    expect(r.leaves).toBeUndefined();
  });
});

describe('classifyIntendedCall — D-5 recursive unwrap (C-03)', () => {
  it('multicall of all in-envelope leaves → L1', () => {
    const leaf = enc(erc20, 'approve', [ROUTER, 10n]) as `0x${string}`;
    const data = enc(multicallAbi, 'multicall', [[leaf, leaf]]);
    const r = classifyIntendedCall(TOKEN, 0n, data, grant([approveRule, multicallRule]), SELF);
    expect(r.classification.lane).toBe('l1');
    expect(r.leaves?.length).toBe(2);
  });

  it('a single forbidden leaf makes the whole wrapper FORBIDDEN', () => {
    const ok = enc(erc20, 'approve', [ROUTER, 10n]) as `0x${string}`;
    // transfer to a self-call target (TOKEN==target, but classify self-call needs target==self)
    // use an infinite approve leaf → forbidden
    const bad = enc(erc20, 'approve', [ROUTER, (1n << 256n) - 1n]) as `0x${string}`;
    const data = enc(multicallAbi, 'multicall', [[ok, bad]]);
    const r = classifyIntendedCall(TOKEN, 0n, data, grant([approveRule, multicallRule]), SELF);
    expect(r.classification).toEqual({ lane: 'forbidden', reason: 'infinite_approval' });
  });

  it('a novel leaf makes the wrapper L2 (union of novelties)', () => {
    const ok = enc(erc20, 'approve', [ROUTER, 10n]) as `0x${string}`;
    const novel = enc(erc20, 'approve', [OTHER, 10n]) as `0x${string}`; // new spender
    const data = enc(multicallAbi, 'multicall', [[ok, novel]]);
    const r = classifyIntendedCall(TOKEN, 0n, data, grant([approveRule, multicallRule]), SELF);
    expect(r.classification.lane).toBe('l2');
    if (r.classification.lane === 'l2') expect(r.classification.novelty).toContain('new_spender');
  });

  it('undecodable wrapper payload → unknown_batcher REFUSE (fail-closed)', () => {
    const sel = toFunctionSelector('function multicall(bytes[])');
    const garbage = sel + 'ab'.repeat(40); // not a valid bytes[] encoding
    const r = classifyIntendedCall(TOKEN, 0n, garbage, grant([multicallRule]), SELF);
    expect(r.classification).toEqual({ lane: 'forbidden', reason: 'unknown_batcher' });
  });

  it('nested-wrapper depth bomb → refused past the depth cap', () => {
    // multicall(multicall(multicall(multicall(multicall(approve))))) — 5 deep > cap 4
    let inner = enc(erc20, 'approve', [ROUTER, 10n]) as `0x${string}`;
    for (let i = 0; i < 5; i++) inner = enc(multicallAbi, 'multicall', [[inner]]) as `0x${string}`;
    const r = classifyIntendedCall(TOKEN, 0n, inner, grant([approveRule, multicallRule]), SELF);
    expect(r.classification.lane).toBe('forbidden');
  });

  it('too many leaves (return-bomb / gas grief M-02) → refused', () => {
    const leaf = enc(erc20, 'approve', [ROUTER, 1n]) as `0x${string}`;
    const many = Array(65).fill(leaf);
    const data = enc(multicallAbi, 'multicall', [many]);
    const r = classifyIntendedCall(TOKEN, 0n, data, grant([approveRule, multicallRule]), SELF);
    expect(r.classification).toEqual({ lane: 'forbidden', reason: 'unknown_batcher' });
  });
});
