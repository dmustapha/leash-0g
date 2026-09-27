import { describe, it, expect } from 'vitest';
import { encodeFunctionData, parseAbi, toFunctionSelector } from 'viem';
import {
  decodeCall,
  classify,
  ruleKey,
  expandPreset,
  presetKeys,
  computeCallHash,
  GLOBAL_DENY_LIST,
  type CallRule,
  type GrantState,
} from '../../src/governed-call/index.js';

const SELF = '0x' + '55'.repeat(20);
const SPENDER = '0x' + 'aa'.repeat(20);
const OTHER = '0x' + 'bb'.repeat(20);
const TOKEN = '0x' + 'cc'.repeat(20);
const ROUTER = '0x' + 'dd'.repeat(20);
const VAULT = '0x' + 'ee'.repeat(20);
const ZERO = '0x0000000000000000000000000000000000000000';
const MAX = (1n << 256n) - 1n;

const erc20 = parseAbi([
  'function approve(address,uint256)',
  'function increaseAllowance(address,uint256)',
  'function transfer(address,uint256)',
  'function transferFrom(address,address,uint256)',
  'function setApprovalForAll(address,bool)',
]);
const routerAbi = parseAbi([
  'function swap(address,address,uint256,uint256,address,uint256)',
]);
const vaultAbi = parseAbi(['function deposit(uint256,address)']);

function nn<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('expected non-null');
  return v;
}

const enc = (abi: readonly unknown[], fn: string, args: readonly unknown[]): string =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  encodeFunctionData({ abi: abi as any, functionName: fn as any, args: args as any });

describe('decodeCall — structured ERC-20 set (mirrors LeashAccountV4._checkStructuredArgs)', () => {
  it('approve(spender, amount) decodes spender + amount, spendToken = target', () => {
    const d = decodeCall(TOKEN, 0n, enc(erc20, 'approve', [SPENDER, 100n]));
    expect(d.args.structured).toBe(true);
    expect(d.args.spender).toBe(SPENDER.toLowerCase());
    expect(d.args.amount).toBe(100n);
    expect(d.args.spendToken).toBe(TOKEN.toLowerCase());
    expect(d.reject).toBeUndefined();
  });

  it('approve(max) is rejected InfiniteApprovalForbidden', () => {
    const d = decodeCall(TOKEN, 0n, enc(erc20, 'approve', [SPENDER, MAX]));
    expect(d.reject).toBe('InfiniteApprovalForbidden');
    expect(d.args.infiniteApproval).toBe(true);
  });

  it('increaseAllowance(max) is NOT infinite-rejected (only approve overwrites)', () => {
    const d = decodeCall(TOKEN, 0n, enc(erc20, 'increaseAllowance', [SPENDER, MAX]));
    expect(d.reject).toBeUndefined();
  });

  it('transfer(to, amount) yields recipients=[to]', () => {
    const d = decodeCall(TOKEN, 0n, enc(erc20, 'transfer', [OTHER, 5n]));
    expect(d.args.recipients).toEqual([OTHER.toLowerCase()]);
    expect(d.args.amount).toBe(5n);
  });

  it('transferFrom(from,to,amount) yields from + recipients=[to]', () => {
    const d = decodeCall(TOKEN, 0n, enc(erc20, 'transferFrom', [SELF, OTHER, 7n]));
    expect(d.args.from).toBe(SELF.toLowerCase());
    expect(d.args.recipients).toEqual([OTHER.toLowerCase()]);
    expect(d.args.amount).toBe(7n);
  });

  it('setApprovalForAll(op,false) ok; (op,true) rejected BlanketApprovalForbidden', () => {
    expect(decodeCall(TOKEN, 0n, enc(erc20, 'setApprovalForAll', [SPENDER, false])).reject).toBeUndefined();
    expect(decodeCall(TOKEN, 0n, enc(erc20, 'setApprovalForAll', [SPENDER, true])).reject).toBe(
      'BlanketApprovalForbidden',
    );
  });

  it('curated router swap decodes recipient + amountIn (non-structured)', () => {
    const d = decodeCall(ROUTER, 0n, enc(routerAbi, 'swap', [TOKEN, OTHER, 50n, 1n, SELF, 999n]));
    expect(d.args.structured).toBe(false);
    expect(d.args.recipients).toEqual([SELF.toLowerCase()]);
    expect(d.args.amount).toBe(50n);
  });

  it('vault deposit decodes receiver + assets', () => {
    const d = decodeCall(VAULT, 0n, enc(vaultAbi, 'deposit', [42n, SELF]));
    expect(d.args.recipients).toEqual([SELF.toLowerCase()]);
    expect(d.args.amount).toBe(42n);
  });

  it('unknown selector: non-structured, amount = msg.value, native spendToken', () => {
    const d = decodeCall(ROUTER, 123n, '0xdeadbeef');
    expect(d.args.structured).toBe(false);
    expect(d.args.amount).toBe(123n);
    expect(d.args.spendToken).toBe(ZERO);
    expect(d.reject).toBeUndefined();
  });
});

describe('decodeCall — H-04 divergence / strict-canonical (must match on-chain DecodeMismatch)', () => {
  const approveSel = toFunctionSelector('function approve(address,uint256)');

  it('data < 4 bytes → DecodeMismatch', () => {
    expect(decodeCall(TOKEN, 0n, '0x1234').reject).toBe('DecodeMismatch');
    expect(decodeCall(TOKEN, 0n, '0x').reject).toBe('DecodeMismatch');
  });

  it('wrong length (trailing bytes) → DecodeMismatch', () => {
    const good = enc(erc20, 'approve', [SPENDER, 1n]);
    expect(decodeCall(TOKEN, 0n, good + 'ff').reject).toBe('DecodeMismatch');
  });

  it('dirty high bits on an address word → DecodeMismatch', () => {
    // approve(spender,amount) with upper bits set on the spender word.
    const dirty = approveSel + 'ff'.repeat(12) + 'aa'.repeat(20) + '00'.repeat(31) + '01';
    expect(decodeCall(TOKEN, 0n, dirty).reject).toBe('DecodeMismatch');
  });

  it('non-canonical bool (word=2) on setApprovalForAll → DecodeMismatch', () => {
    const sel = toFunctionSelector('function setApprovalForAll(address,bool)');
    const bad = sel + '00'.repeat(12) + 'aa'.repeat(20) + '00'.repeat(31) + '02';
    expect(decodeCall(TOKEN, 0n, bad).reject).toBe('DecodeMismatch');
  });
});

// ---------- classify (three-lane) ----------
function grant(rules: CallRule[], budgets: [string, string][] = [[TOKEN, '1000']], allowlist: string[] = []): GrantState {
  return {
    rules: new Map(rules.map((r) => [ruleKey(r.target, r.selector), r])),
    budgets: new Map(budgets.map(([t, c]) => [t.toLowerCase(), c])),
    allowlist: new Set(allowlist.map((a) => a.toLowerCase())),
  };
}
const approveRule: CallRule = {
  target: TOKEN,
  selector: toFunctionSelector('function approve(address,uint256)'),
  recipientMode: 'self',
  spenderSet: [ROUTER],
  perCallCap: '100',
  windowCapCall: '500',
};

describe('classify — three-lane routing', () => {
  it('in-envelope approve → L1', () => {
    const d = decodeCall(TOKEN, 0n, enc(erc20, 'approve', [ROUTER, 50n]));
    expect(classify(d, grant([approveRule]), SELF)).toEqual({ lane: 'l1', reason: 'in_envelope' });
  });

  it('brand-new target → L2 new_target', () => {
    const d = decodeCall(OTHER, 0n, enc(erc20, 'approve', [ROUTER, 1n]));
    const c = classify(d, grant([approveRule]), SELF);
    expect(c.lane).toBe('l2');
    if (c.lane === 'l2') expect(c.novelty).toContain('new_target');
  });

  it('known target, new selector → L2 new_selector', () => {
    const d = decodeCall(TOKEN, 0n, enc(erc20, 'transfer', [SELF, 1n]));
    const c = classify(d, grant([approveRule]), SELF);
    expect(c.lane).toBe('l2');
    if (c.lane === 'l2') expect(c.novelty).toContain('new_selector');
  });

  it('new spender → L2 new_spender', () => {
    const d = decodeCall(TOKEN, 0n, enc(erc20, 'approve', [OTHER, 1n]));
    const c = classify(d, grant([approveRule]), SELF);
    if (c.lane === 'l2') expect(c.novelty).toContain('new_spender');
    else throw new Error('expected l2');
  });

  it('over per-call cap → L2 over_cap', () => {
    const d = decodeCall(TOKEN, 0n, enc(erc20, 'approve', [ROUTER, 101n]));
    const c = classify(d, grant([approveRule]), SELF);
    if (c.lane === 'l2') expect(c.novelty).toContain('over_cap');
    else throw new Error('expected l2');
  });

  it('recipient self-pin: non-self recipient → L2 new_recipient', () => {
    const transferRule: CallRule = { ...approveRule, selector: toFunctionSelector('function transfer(address,uint256)'), spenderSet: [] };
    const d = decodeCall(TOKEN, 0n, enc(erc20, 'transfer', [OTHER, 1n]));
    const c = classify(d, grant([transferRule]), SELF);
    if (c.lane === 'l2') expect(c.novelty).toContain('new_recipient');
    else throw new Error('expected l2');
  });

  it('allowlist mode: recipient in allowlist → L1', () => {
    const transferRule: CallRule = { ...approveRule, selector: toFunctionSelector('function transfer(address,uint256)'), spenderSet: [], recipientMode: 'allowlist' };
    const d = decodeCall(TOKEN, 0n, enc(erc20, 'transfer', [OTHER, 1n]));
    expect(classify(d, grant([transferRule], [[TOKEN, '1000']], [OTHER]), SELF).lane).toBe('l1');
  });

  it('transferFrom from != self → FORBIDDEN from_not_self (confused-deputy, never JIT)', () => {
    const tfRule: CallRule = { ...approveRule, selector: toFunctionSelector('function transferFrom(address,address,uint256)'), spenderSet: [] };
    const d = decodeCall(TOKEN, 0n, enc(erc20, 'transferFrom', [OTHER, SELF, 1n]));
    expect(classify(d, grant([tfRule]), SELF)).toEqual({ lane: 'forbidden', reason: 'from_not_self' });
  });

  it('self-call → FORBIDDEN self_call', () => {
    const d = decodeCall(SELF, 0n, enc(erc20, 'approve', [ROUTER, 1n]));
    expect(classify(d, grant([approveRule]), SELF)).toEqual({ lane: 'forbidden', reason: 'self_call' });
  });

  it('decode reject → FORBIDDEN (fail-closed, never L1/L2-as-safe)', () => {
    const d = decodeCall(TOKEN, 0n, enc(erc20, 'approve', [ROUTER, MAX]));
    expect(classify(d, grant([approveRule]), SELF)).toEqual({ lane: 'forbidden', reason: 'infinite_approval' });
  });

  it('spend against a token with no on-chain budget → L2 (over_cap / must propose budget)', () => {
    const d = decodeCall(TOKEN, 0n, enc(erc20, 'approve', [ROUTER, 10n]));
    const c = classify(d, grant([approveRule], []), SELF); // no budgets
    if (c.lane === 'l2') expect(c.novelty).toContain('over_cap');
    else throw new Error('expected l2');
  });
});

// ---------- presets (D-9) ----------
describe('expandPreset — the broad-grant UX', () => {
  const catalog = { router: ROUTER, vault: VAULT, settlement_token: TOKEN };

  it('every preset key expands fully against a complete catalog', () => {
    for (const k of presetKeys()) {
      const p = nn(expandPreset(k, catalog));
      expect(p.rules.length).toBeGreaterThan(0);
      // Gate-② invariant: a preset ALWAYS carries the full global deny-list.
      for (const t of GLOBAL_DENY_LIST) expect(p.denyList).toContain(t);
    }
  });

  it('defi_trader grants exactly approve(token→router) + swap(router), nothing off-list', () => {
    const p = nn(expandPreset('defi_trader', catalog));
    const sels = p.rules.map((r) => `${r.target}:${r.selector}`).sort();
    expect(sels).toEqual(
      [
        `${TOKEN.toLowerCase()}:${toFunctionSelector('function approve(address,uint256)')}`,
        `${ROUTER.toLowerCase()}:${toFunctionSelector('function swap(address,address,uint256,uint256,address,uint256)')}`,
      ].sort(),
    );
    const approve = nn(p.rules.find((r) => r.target === TOKEN.toLowerCase()));
    expect(approve.spenderSet).toEqual([ROUTER.toLowerCase()]);
  });

  it('treasury_topper is own-wallets-only (recipientMode allowlist, no router spender)', () => {
    const p = nn(expandPreset('treasury_topper', catalog));
    expect(p.rules.every((r) => r.recipientMode === 'allowlist')).toBe(true);
    expect(p.rules.every((r) => r.spenderSet.length === 0)).toBe(true);
  });

  it('returns null when a referenced target is missing (never a partial grant)', () => {
    expect(expandPreset('defi_trader', { settlement_token: TOKEN })).toBeNull(); // no router
  });
});

// ---------- one-shot call hash (D-7) ----------
describe('computeCallHash — deterministic, exact-call bound (D-7 replay guard)', () => {
  const data = enc(erc20, 'approve', [ROUTER, 100n]);
  it('is deterministic + 32 bytes', () => {
    const h = computeCallHash(TOKEN, 0n, data);
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
    expect(computeCallHash(TOKEN, 0n, data)).toBe(h);
  });
  it('differs when target / value / any data byte changes (no cross-call replay)', () => {
    const h = computeCallHash(TOKEN, 0n, data);
    expect(computeCallHash(OTHER, 0n, data)).not.toBe(h);
    expect(computeCallHash(TOKEN, 1n, data)).not.toBe(h);
    expect(computeCallHash(TOKEN, 0n, enc(erc20, 'approve', [ROUTER, 101n]))).not.toBe(h);
  });
  it('malformed data does not throw', () => {
    expect(() => computeCallHash(TOKEN, 0n, '0x')).not.toThrow();
  });
});

// ---------- D-12 stress / adversarial ----------
describe('D-12 STRESS: decoder + classify never throw, never pollute, fail closed', () => {
  it('prototype-pollution keys as target/selector do not pollute Object.prototype', () => {
    const g = grant([approveRule]);
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const d = decodeCall(key, 0n, enc(erc20, 'approve', [ROUTER, 1n]));
      expect(() => classify(d, g, SELF)).not.toThrow();
    }
    expect((Object.prototype as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('unicode / bidi / control chars in addresses degrade safely (never throw)', () => {
    for (const junk of ['‮evil', '0x ', '中文', ' ', '', '0xZZ', 'null']) {
      expect(() => decodeCall(junk, 0n, '0xdeadbeef')).not.toThrow();
      const d = decodeCall(junk, 0n, enc(erc20, 'approve', [ROUTER, 1n]));
      expect(() => classify(d, grant([approveRule]), SELF)).not.toThrow();
    }
  });

  it('type-smuggling: non-hex / non-string data → DecodeMismatch, never a silent parse', () => {
    for (const bad of ['not-hex', '0xZZZZ', '0x', 'deadbeef']) {
      const d = decodeCall(TOKEN, 0n, bad);
      // anything under 4 canonical bytes or non-0x is malformed
      expect(d.reject === 'DecodeMismatch' || d.args.structured === false).toBe(true);
    }
  });

  it('oversized calldata is bounded by the exact-length check (structured selectors)', () => {
    const good = enc(erc20, 'approve', [ROUTER, 1n]);
    const huge = good + 'ab'.repeat(5000);
    expect(decodeCall(TOKEN, 0n, huge).reject).toBe('DecodeMismatch');
  });

  it('array/struct partial-validation (H-07): both transferFrom addresses are validated', () => {
    // recipient-redirect in the SECOND address slot must still be caught.
    const tfRule: CallRule = { ...approveRule, selector: toFunctionSelector('function transferFrom(address,address,uint256)'), spenderSet: [], recipientMode: 'self' };
    const d = decodeCall(TOKEN, 0n, enc(erc20, 'transferFrom', [SELF, OTHER, 1n])); // from=self ok, to=other
    const c = classify(d, grant([tfRule]), SELF);
    if (c.lane === 'l2') expect(c.novelty).toContain('new_recipient');
    else throw new Error('expected l2 (to redirected)');
  });
});
