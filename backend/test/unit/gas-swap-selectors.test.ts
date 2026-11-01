import { describe, it, expect } from 'vitest';
import { decodeFunctionData, parseAbi, toFunctionSelector } from 'viem';
import {
  buildGasSwapCalls,
  buildWrappedNativeUnwrap,
  classify,
  decodeCall,
  expandPreset,
  ruleKey,
  GAS_SWAP_AMOUNT_OUT_MINIMUM,
  type CallRule,
  type GrantState,
} from '../../src/governed-call/index.js';

/**
 * AQ-FND M-3 inc-3a — the swap-to-gas SelectorSpecs (SwapRouter02 exactInputSingle 0x04e45aaf +
 * WETH9 withdraw 0x2e1a7d4d) and the server-side builder. Pins: strict-canonical round-trip, the
 * recipient / tokenOut / spender / budget refusals, and builder determinism.
 */

const SELF = '0x' + '55'.repeat(20);
const ATTACKER = '0x' + 'bb'.repeat(20);
const ROUTER = '0x' + 'dd'.repeat(20);
const USDC = '0x' + 'cc'.repeat(20);
const WETH = '0x' + 'ee'.repeat(20);
const OTHER_TOKEN = '0x' + 'a1'.repeat(20);
const SEL_SWAP = toFunctionSelector(
  'function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))',
);
const SEL_WITHDRAW = toFunctionSelector('function withdraw(uint256)');
const SEL_APPROVE = toFunctionSelector('function approve(address,uint256)');

const params = { self: SELF as `0x${string}`, token: USDC as `0x${string}`, router: ROUTER as `0x${string}`, wrappedNative: WETH as `0x${string}`, feeTier: 3000, amountIn: 5_000_000n };

const swapAbi = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params)',
]);

function rule(target: string, selector: string, over: Partial<CallRule> = {}): CallRule {
  return { target, selector, recipientMode: 'self', spenderSet: [], perCallCap: '20000000', windowCapCall: '100000000', ...over };
}

function grant(over: { rules?: CallRule[]; budgets?: string[]; swapOut?: string[] | undefined } = {}): GrantState {
  const rules = over.rules ?? [
    rule(USDC, SEL_APPROVE, { spenderSet: [ROUTER] }),
    rule(ROUTER, SEL_SWAP),
    rule(WETH, SEL_WITHDRAW, { perCallCap: '1000000000000000000' }),
  ];
  const state: GrantState = {
    rules: new Map(rules.map((r) => [ruleKey(r.target, r.selector), r])),
    budgets: new Map((over.budgets ?? [USDC]).map((t) => [t.toLowerCase(), '100000000'])),
    allowlist: new Set<string>(),
  };
  const swapOut = 'swapOut' in over ? over.swapOut : [WETH];
  if (swapOut) state.swapOutputTokens = new Set(swapOut.map((a) => a.toLowerCase()));
  return state;
}

describe('selectors — registered with the expected 4-byte ids', () => {
  it('exactInputSingle is 0x04e45aaf and withdraw is 0x2e1a7d4d', () => {
    expect(SEL_SWAP.toLowerCase()).toBe('0x04e45aaf');
    expect(SEL_WITHDRAW.toLowerCase()).toBe('0x2e1a7d4d');
  });
});

describe('buildGasSwapCalls — deterministic, server-pinned', () => {
  it('is deterministic and round-trips through the viem ABI', () => {
    const a = buildGasSwapCalls(params);
    const b = buildGasSwapCalls({ ...params });
    expect(a).toEqual(b);
    expect(a.approve.target).toBe(USDC);
    expect(a.swap.target).toBe(ROUTER);
    expect(a.swap.data.slice(0, 10)).toBe('0x04e45aaf');
    const dec = decodeFunctionData({ abi: swapAbi, data: a.swap.data });
    const lc = (a: string): string => a.toLowerCase();
    const got = dec.args[0];
    expect({ ...got, tokenIn: lc(got.tokenIn), tokenOut: lc(got.tokenOut), recipient: lc(got.recipient) }).toEqual({
      tokenIn: USDC,
      tokenOut: WETH,
      fee: 3000,
      recipient: SELF,
      amountIn: 5_000_000n,
      amountOutMinimum: GAS_SWAP_AMOUNT_OUT_MINIMUM,
      sqrtPriceLimitX96: 0n,
    });
    // fixed 7-word tuple: 4 + 7*32 bytes
    expect((a.swap.data.length - 2) / 2).toBe(4 + 7 * 32);
    const unwrap = buildWrappedNativeUnwrap(WETH as `0x${string}`, 123n);
    expect(unwrap.data.slice(0, 10)).toBe('0x2e1a7d4d');
    expect((unwrap.data.length - 2) / 2).toBe(4 + 32);
  });
});

describe('decodeCall — exactInputSingle', () => {
  const { swap, approve } = buildGasSwapCalls(params);

  it('decodes the authority args (tokenIn budget key, amountIn, recipient, tokenOut)', () => {
    const d = decodeCall(ROUTER, 0n, swap.data);
    expect(d.reject).toBeUndefined();
    expect(d.args.spendToken).toBe(USDC);
    expect(d.args.amount).toBe(5_000_000n);
    expect(d.args.recipients).toEqual([SELF]);
    expect(d.args.swapTokenOut).toBe(WETH);
  });

  it('refuses msg.value, a nonzero sqrtPriceLimit, a dirty fee word, and a bad length', () => {
    expect(decodeCall(ROUTER, 1n, swap.data).reject).toBe('DecodeMismatch');
    // sqrtPriceLimitX96 is the last word
    const dirtyLimit = swap.data.slice(0, -1) + '1';
    expect(decodeCall(ROUTER, 0n, dirtyLimit).reject).toBe('DecodeMismatch');
    // fee word is the 3rd: set a bit above uint24
    const feeStart = 10 + 2 * 64;
    const dirtyFee = swap.data.slice(0, feeStart) + '00000001' + swap.data.slice(feeStart + 8);
    expect(decodeCall(ROUTER, 0n, dirtyFee).reject).toBe('DecodeMismatch');
    expect(decodeCall(ROUTER, 0n, swap.data + '00').reject).toBe('DecodeMismatch');
  });

  it('decodes the exact-amount approve with the router as spender', () => {
    const d = decodeCall(USDC, 0n, approve.data);
    expect(d.args.spender).toBe(ROUTER);
    expect(d.args.amount).toBe(5_000_000n);
  });
});

describe('decodeCall — WETH9 withdraw', () => {
  it('decodes the amount and charges no token budget (native spend token)', () => {
    const d = decodeCall(WETH, 0n, buildWrappedNativeUnwrap(WETH as `0x${string}`, 777n).data);
    expect(d.reject).toBeUndefined();
    expect(d.args.amount).toBe(777n);
    expect(d.args.spendToken).toBe('0x0000000000000000000000000000000000000000');
  });

  it('refuses msg.value and a trailing byte', () => {
    const data = buildWrappedNativeUnwrap(WETH as `0x${string}`, 1n).data;
    expect(decodeCall(WETH, 1n, data).reject).toBe('DecodeMismatch');
    expect(decodeCall(WETH, 0n, data + '00').reject).toBe('DecodeMismatch');
  });
});

describe('classify — the gas-swap legs against granted vs. attacker-shaped calls', () => {
  const { approve, swap } = buildGasSwapCalls(params);
  const run = (call: { target: string; value: bigint; data: string }, g: GrantState) =>
    classify(decodeCall(call.target, call.value, call.data), g, SELF);

  it('all three legs are L1 under the full grants', () => {
    const g = grant();
    expect(run(approve, g)).toEqual({ lane: 'l1', reason: 'in_envelope' });
    expect(run(swap, g)).toEqual({ lane: 'l1', reason: 'in_envelope' });
    expect(run(buildWrappedNativeUnwrap(WETH as `0x${string}`, 10n ** 15n), g)).toEqual({ lane: 'l1', reason: 'in_envelope' });
  });

  it('recipient != self is NOT in-envelope (new_recipient, never a silent redirect)', () => {
    const bad = buildGasSwapCalls({ ...params, self: ATTACKER as `0x${string}` }).swap;
    const r = run(bad, grant());
    expect(r.lane).toBe('l2');
    if (r.lane === 'l2') expect(r.novelty).toContain('new_recipient');
  });

  it('tokenOut != the chain wrapped-native is FORBIDDEN', () => {
    const bad = buildGasSwapCalls({ ...params, wrappedNative: OTHER_TOKEN as `0x${string}` }).swap;
    expect(run(bad, grant())).toEqual({ lane: 'forbidden', reason: 'swap_output_not_allowed' });
  });

  it('without a pinned output set the swap is not output-pinned (legacy: nothing builds it)', () => {
    const bad = buildGasSwapCalls({ ...params, wrappedNative: OTHER_TOKEN as `0x${string}` }).swap;
    expect(run(bad, grant({ swapOut: undefined })).lane).toBe('l1');
  });

  it('amountIn over the per-call cap is over_cap; no budget on tokenIn is over_budget', () => {
    const big = buildGasSwapCalls({ ...params, amountIn: 25_000_000n }).swap;
    const over = run(big, grant());
    expect(over.lane).toBe('l2');
    if (over.lane === 'l2') expect(over.novelty).toContain('over_cap');
    const nobudget = run(swap, grant({ budgets: [] }));
    expect(nobudget.lane).toBe('l2');
    if (nobudget.lane === 'l2') expect(nobudget.novelty).toContain('over_budget');
  });

  it('approve to any spender other than the router is new_spender; max approve is forbidden', () => {
    const wrongSpender = buildGasSwapCalls({ ...params, router: ATTACKER as `0x${string}` }).approve;
    const r = run(wrongSpender, grant());
    expect(r.lane).toBe('l2');
    if (r.lane === 'l2') expect(r.novelty).toContain('new_spender');
    const max = buildGasSwapCalls({ ...params, amountIn: (1n << 256n) - 1n }).approve;
    expect(run(max, grant())).toEqual({ lane: 'forbidden', reason: 'infinite_approval' });
  });

  it('a missing router rule is L2 (new_target), not a doomed submit', () => {
    const g = grant({ rules: [rule(USDC, SEL_APPROVE, { spenderSet: [ROUTER] })] });
    const r = run(swap, g);
    expect(r.lane).toBe('l2');
    if (r.lane === 'l2') expect(r.novelty).toContain('new_target');
  });
});

describe('gas_swap preset', () => {
  it('expands to the approve / exactInputSingle / withdraw rules; needs wrapped_native in the catalog', () => {
    const p = expandPreset('gas_swap', { router: ROUTER, settlement_token: USDC, wrapped_native: WETH });
    expect(p?.rules.map((r) => [r.target, r.selector])).toEqual([
      [USDC, SEL_APPROVE.toLowerCase()],
      [ROUTER, SEL_SWAP.toLowerCase()],
      [WETH, SEL_WITHDRAW.toLowerCase()],
    ]);
    expect(p?.rules[0]?.spenderSet).toEqual([ROUTER]);
    expect(p?.budgets).toEqual([{ token: USDC, windowCap: '100000000' }]);
    expect(expandPreset('gas_swap', { router: ROUTER, settlement_token: USDC })).toBeNull();
  });
});
