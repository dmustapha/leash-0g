import { describe, it, expect } from 'vitest';
import { encodeFunctionData, parseAbi, toFunctionSelector } from 'viem';
import {
  decodeCall,
  classify,
  buildGovernedCall,
  BRIDGE_SELECTORS,
  ruleKey,
  type CallRule,
  type GrantState,
} from '../../src/governed-call/index.js';
import { classifyIntendedCall } from '../../src/gateway/call-gate.js';

/**
 * SE-8 (E-9) — the governed-bridging grammar: strict-canonical bridge decode
 * mirroring the on-chain OP-stack bridge decoders, BR-2 default-DENY (bridge
 * allowlist consumed by classify — carry #2), and the never-guess-money bridge
 * build (bridgeETHTo authority args pinned server-side).
 */

const SELF = '0x' + '55'.repeat(20);
const BRIDGE = '0x4200000000000000000000000000000000000010';
const OTHER_BRIDGE = '0x' + '99'.repeat(20);
const ATTACKER = '0x' + 'bb'.repeat(20);
const TOKEN = '0x' + 'cc'.repeat(20);
const REMOTE = '0x' + 'dd'.repeat(20);
const ZERO = '0x0000000000000000000000000000000000000000';

const bridgeAbi = parseAbi([
  'function bridgeETHTo(address,uint32,bytes)',
  'function bridgeERC20To(address,address,address,uint256,uint32,bytes)',
]);
const SEL_ETH = toFunctionSelector('function bridgeETHTo(address,uint32,bytes)').toLowerCase();
const SEL_ERC20 = toFunctionSelector(
  'function bridgeERC20To(address,address,address,uint256,uint32,bytes)',
).toLowerCase();

const enc = (fn: string, args: readonly unknown[]): string =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  encodeFunctionData({ abi: bridgeAbi as any, functionName: fn as any, args: args as any });

function rule(target: string, selector: string, over: Partial<CallRule> = {}): CallRule {
  return {
    target: target.toLowerCase(),
    selector: selector.toLowerCase(),
    recipientMode: 'self',
    spenderSet: [],
    perCallCap: '1000000000000000000', // 1 ether
    windowCapCall: '2000000000000000000',
    ...over,
  };
}

function grant(rules: CallRule[], opts: { budgets?: [string, string][]; bridgeTargets?: string[] } = {}): GrantState {
  return {
    rules: new Map(rules.map((r) => [ruleKey(r.target, r.selector), r])),
    budgets: new Map((opts.budgets ?? [[ZERO, '2000000000000000000'], [BRIDGE.toLowerCase(), '2000000000000000000']]).map(([k, v]) => [k.toLowerCase(), v])),
    allowlist: new Set<string>(),
    ...(opts.bridgeTargets ? { bridgeTargets: new Set(opts.bridgeTargets.map((t) => t.toLowerCase())) } : {}),
  };
}

describe('SE-8 decodeCall — bridge decoders (mirror the on-chain wall byte-for-byte)', () => {
  it('bridgeETHTo canonical: recipient decoded, amount = msg.value, native spendToken', () => {
    const d = decodeCall(BRIDGE, 500n, enc('bridgeETHTo', [SELF, 200000, '0x']));
    expect(d.reject).toBeUndefined();
    expect(d.args.structured).toBe(true);
    expect(d.args.recipients).toEqual([SELF.toLowerCase()]);
    expect(d.args.amount).toBe(500n); // valueIsAmount
    expect(d.args.spendToken).toBe(ZERO);
  });

  it('bridgeERC20To canonical: recipient + amount decoded, spendToken = the bridge target', () => {
    const d = decodeCall(BRIDGE, 0n, enc('bridgeERC20To', [TOKEN, REMOTE, SELF, 777n, 200000, '0x']));
    expect(d.reject).toBeUndefined();
    expect(d.args.recipients).toEqual([SELF.toLowerCase()]);
    expect(d.args.amount).toBe(777n);
    expect(d.args.spendToken).toBe(BRIDGE.toLowerCase());
  });

  it('non-empty extraData is a payload surface → DecodeMismatch (both selectors)', () => {
    expect(decodeCall(BRIDGE, 1n, enc('bridgeETHTo', [SELF, 200000, '0xdeadbeef'])).reject).toBe('DecodeMismatch');
    expect(decodeCall(BRIDGE, 0n, enc('bridgeERC20To', [TOKEN, REMOTE, SELF, 1n, 200000, '0x01'])).reject).toBe(
      'DecodeMismatch',
    );
  });

  it('dirty bits above uint32 minGasLimit → DecodeMismatch', () => {
    const base = enc('bridgeETHTo', [SELF, 200000, '0x']);
    // minGas word = 2nd arg word: hex chars [10+64, 10+128); poison a high byte
    const dirty = base.slice(0, 10 + 64) + 'ff' + base.slice(10 + 66);
    expect(decodeCall(BRIDGE, 1n, dirty).reject).toBe('DecodeMismatch');
  });

  it('dirty high bits on the recipient word → DecodeMismatch', () => {
    const base = enc('bridgeETHTo', [SELF, 200000, '0x']);
    const dirty = base.slice(0, 10) + 'ff' + base.slice(12);
    expect(decodeCall(BRIDGE, 1n, dirty).reject).toBe('DecodeMismatch');
  });

  it('non-canonical extraData head offset → DecodeMismatch', () => {
    const base = enc('bridgeETHTo', [SELF, 200000, '0x']);
    // offset word is the 3rd arg word; overwrite 0x60 → 0x80 (with a padding word to keep length)
    const words = base.slice(10).match(/.{64}/g) ?? [];
    words[2] = '0'.repeat(62) + '80';
    expect(decodeCall(BRIDGE, 1n, base.slice(0, 10) + words.join('')).reject).toBe('DecodeMismatch');
  });

  it('msg.value on the nonpayable ERC-20 leg → DecodeMismatch (value never rides uncharged)', () => {
    const d = decodeCall(BRIDGE, 1n, enc('bridgeERC20To', [TOKEN, REMOTE, SELF, 1n, 200000, '0x']));
    expect(d.reject).toBe('DecodeMismatch');
  });

  it('wrong length (truncated tail) → DecodeMismatch', () => {
    const base = enc('bridgeETHTo', [SELF, 200000, '0x']);
    expect(decodeCall(BRIDGE, 1n, base.slice(0, base.length - 64)).reject).toBe('DecodeMismatch');
  });
});

describe('SE-8 classify — BR-2 default-DENY + the consumed bridge allowlist (carry #2)', () => {
  const ethData = enc('bridgeETHTo', [SELF, 200000, '0x']);

  it('a granted, in-cap bridge call on an ALLOWLISTED bridge is L1 (ordinary governed calldata)', () => {
    const g = grant([rule(BRIDGE, SEL_ETH)], { bridgeTargets: [BRIDGE] });
    const c = classify(decodeCall(BRIDGE, 500n, ethData), g, SELF);
    expect(c).toEqual({ lane: 'l1', reason: 'in_envelope' });
  });

  it('a bridge selector against a target OUTSIDE the bridge allowlist → forbidden bridge_not_allowlisted', () => {
    const g = grant([rule(OTHER_BRIDGE, SEL_ETH)], { bridgeTargets: [BRIDGE] });
    const c = classify(decodeCall(OTHER_BRIDGE, 500n, ethData), g, SELF);
    expect(c).toEqual({ lane: 'forbidden', reason: 'bridge_not_allowlisted' });
  });

  it('NO bridgeTargets at all (chain allows no bridges) → every bridge selector is forbidden', () => {
    const g = grant([rule(BRIDGE, SEL_ETH)]);
    const c = classify(decodeCall(BRIDGE, 500n, ethData), g, SELF);
    expect(c).toEqual({ lane: 'forbidden', reason: 'bridge_not_allowlisted' });
  });

  it('a NON-bridge selector against a bridge-allowlisted target → forbidden bridge_undecodable (BR-2)', () => {
    // e.g. an owner-granted arbitrary selector on the bridge — without a structured
    // decoder the amount would ride uncharged through the msg.value lane. DENY.
    const selWithdraw = toFunctionSelector('function withdraw(address,uint256,uint32,bytes)').toLowerCase();
    const g = grant([rule(BRIDGE, selWithdraw)], { bridgeTargets: [BRIDGE] });
    const data = selWithdraw + '00'.repeat(32);
    const c = classify(decodeCall(BRIDGE, 0n, data), g, SELF);
    expect(c).toEqual({ lane: 'forbidden', reason: 'bridge_undecodable' });
  });

  it('a redirect (recipient != self under mode self) is novelty new_recipient → L2, never L1', () => {
    const g = grant([rule(BRIDGE, SEL_ETH)], { bridgeTargets: [BRIDGE] });
    const c = classify(decodeCall(BRIDGE, 500n, enc('bridgeETHTo', [ATTACKER, 200000, '0x'])), g, SELF);
    expect(c.lane).toBe('l2');
    expect((c as { novelty: string[] }).novelty).toContain('new_recipient');
  });

  it('an over-cap bridge amount is novelty over_cap → L2 (JIT), never L1', () => {
    const g = grant([rule(BRIDGE, SEL_ETH, { perCallCap: '100' })], { bridgeTargets: [BRIDGE] });
    const c = classify(decodeCall(BRIDGE, 500n, ethData), g, SELF);
    expect(c.lane).toBe('l2');
    expect((c as { novelty: string[] }).novelty).toContain('over_cap');
  });

  it('the call-gate routes bridge calls through the same classify (no wrapper bypass)', () => {
    const g = grant([rule(BRIDGE, SEL_ETH)], { bridgeTargets: [BRIDGE] });
    const r = classifyIntendedCall(BRIDGE, 500n, ethData, g, SELF);
    expect(r.classification).toEqual({ lane: 'l1', reason: 'in_envelope' });
  });
});

describe('SE-8 buildGovernedCall — never-guess-money bridge build', () => {
  it('bridgeETHTo builds with recipient pinned to SELF, server minGas, empty extraData, value = amount', () => {
    const g = grant([rule(BRIDGE, SEL_ETH)], { bridgeTargets: [BRIDGE] });
    const built = buildGovernedCall({ target: BRIDGE, selector: SEL_ETH, amountWei: '500' }, g, SELF);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value).toBe(500n); // the bridged amount IS msg.value
    // byte-parity with the trusted viem encoding of the pinned args
    expect(built.data).toBe(enc('bridgeETHTo', [SELF, 200000, '0x']).toLowerCase());
    // and the built bytes decode canonically (would pass the on-chain wall's decode)
    const d = decodeCall(BRIDGE, built.value, built.data);
    expect(d.reject).toBeUndefined();
    expect(d.args.recipients).toEqual([SELF.toLowerCase()]);
  });

  it('bridgeETHTo with an allowlist-mode rule is NOT authority-determined (which recipient?)', () => {
    const g = grant([rule(BRIDGE, SEL_ETH, { recipientMode: 'allowlist' })], { bridgeTargets: [BRIDGE] });
    const built = buildGovernedCall({ target: BRIDGE, selector: SEL_ETH, amountWei: '500' }, g, SELF);
    expect(built).toEqual({ ok: false, reason: 'not_authority_determined' });
  });

  it('bridgeERC20To is NOT buildable from model intent (token route args are free) — owner JIT only', () => {
    const g = grant([rule(BRIDGE, SEL_ERC20)], { bridgeTargets: [BRIDGE] });
    const built = buildGovernedCall({ target: BRIDGE, selector: SEL_ERC20, amountWei: '500' }, g, SELF);
    expect(built).toEqual({ ok: false, reason: 'not_authority_determined' });
  });

  it('an ungranted bridge is not buildable at all (no_grant) — hijacked free-bridge refused by construction', () => {
    const g = grant([], { bridgeTargets: [BRIDGE] });
    const built = buildGovernedCall({ target: BRIDGE, selector: SEL_ETH, amountWei: '500' }, g, SELF);
    expect(built).toEqual({ ok: false, reason: 'no_grant' });
  });

  it('BRIDGE_SELECTORS carries exactly the two structured bridge decoders', () => {
    expect([...BRIDGE_SELECTORS].sort()).toEqual([SEL_ERC20, SEL_ETH].sort());
  });
});
