import { describe, it, expect } from 'vitest';
import { decodeFunctionData, parseAbi, toFunctionSelector } from 'viem';
import {
  buildGovernedCall,
  decodeCall,
  classify,
  ruleKey,
  type CallRule,
  type GrantState,
} from '../../src/governed-call/index.js';

/**
 * The never-guess-money call-builder (D-10): authority args (spender/recipient/
 * from) come ONLY from server-side grant state; the model contributes only
 * (target, selector, amount). These tests prove the money spine: no model text
 * can redirect a recipient or inject a spender, ambiguous grants refuse, and the
 * built calldata round-trips through the decoder + classifier as L1 in-envelope.
 */

const SELF = '0x' + '55'.repeat(20);
const SPENDER = '0x' + 'aa'.repeat(20);
const ATTACKER = '0x' + 'bb'.repeat(20);
const TOKEN = '0x' + 'cc'.repeat(20);
const VAULT = '0x' + 'ee'.repeat(20);

const erc20 = parseAbi([
  'function approve(address,uint256)',
  'function transfer(address,uint256)',
  'function transferFrom(address,address,uint256)',
  'function setApprovalForAll(address,bool)',
]);
const vaultAbi = parseAbi(['function deposit(uint256,address)']);

const SEL = {
  approve: toFunctionSelector('function approve(address,uint256)').toLowerCase(),
  transfer: toFunctionSelector('function transfer(address,uint256)').toLowerCase(),
  transferFrom: toFunctionSelector('function transferFrom(address,address,uint256)').toLowerCase(),
  setApprovalForAll: toFunctionSelector('function setApprovalForAll(address,bool)').toLowerCase(),
  deposit: toFunctionSelector('function deposit(uint256,address)').toLowerCase(),
  swap: toFunctionSelector('function swap(address,address,uint256,uint256,address,uint256)').toLowerCase(),
};

function rule(over: Partial<CallRule>): CallRule {
  return {
    target: TOKEN,
    selector: SEL.approve,
    recipientMode: 'self',
    spenderSet: [SPENDER],
    perCallCap: '1000000',
    windowCapCall: '5000000',
    ...over,
  };
}

function grantOf(...rules: CallRule[]): GrantState {
  const map = new Map<string, CallRule>();
  for (const r of rules) map.set(ruleKey(r.target, r.selector), r);
  return { rules: map, budgets: new Map([[TOKEN.toLowerCase(), '5000000']]), allowlist: new Set() };
}

describe('buildGovernedCall — never-guess-money', () => {
  it('approve: pins spender from the grant (not model text) + model amount', () => {
    const g = grantOf(rule({}));
    const res = buildGovernedCall({ target: TOKEN, selector: SEL.approve, amountWei: '100' }, g, SELF);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const { functionName, args } = decodeFunctionData({ abi: erc20, data: res.data as `0x${string}` });
    expect(functionName).toBe('approve');
    expect((args[0] as string).toLowerCase()).toBe(SPENDER); // spender from grant.spenderSet, NEVER model
    expect(args[1]).toBe(100n);
    expect(res.value).toBe(0n);
  });

  it('transfer: pins recipient to SELF regardless of anything the model could say', () => {
    const g = grantOf(rule({ selector: SEL.transfer }));
    const res = buildGovernedCall({ target: TOKEN, selector: SEL.transfer, amountWei: '42' }, g, SELF);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const { functionName, args } = decodeFunctionData({ abi: erc20, data: res.data as `0x${string}` });
    expect(functionName).toBe('transfer');
    expect((args[0] as string).toLowerCase()).toBe(SELF.toLowerCase());
    expect(args[1]).toBe(42n);
  });

  it('transferFrom: pins from AND to to SELF (no confused-deputy pull)', () => {
    const g = grantOf(rule({ selector: SEL.transferFrom }));
    const res = buildGovernedCall({ target: TOKEN, selector: SEL.transferFrom, amountWei: '7' }, g, SELF);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const { args } = decodeFunctionData({ abi: erc20, data: res.data as `0x${string}` });
    expect((args[0] as string).toLowerCase()).toBe(SELF.toLowerCase()); // from == self
    expect((args[1] as string).toLowerCase()).toBe(SELF.toLowerCase()); // to == self
    expect(args[2]).toBe(7n);
  });

  it('deposit(assets, receiver): receiver pinned to SELF, assets = model amount', () => {
    const g = grantOf(rule({ target: VAULT, selector: SEL.deposit, recipientMode: 'self' }));
    const res = buildGovernedCall({ target: VAULT, selector: SEL.deposit, amountWei: '500' }, g, SELF);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const { functionName, args } = decodeFunctionData({ abi: vaultAbi, data: res.data as `0x${string}` });
    expect(functionName).toBe('deposit');
    expect(args[0]).toBe(500n); // assets
    expect((args[1] as string).toLowerCase()).toBe(SELF.toLowerCase()); // receiver == self
  });

  it('the built call round-trips: decode + classify → L1 in-envelope', () => {
    const g = grantOf(rule({}));
    const res = buildGovernedCall({ target: TOKEN, selector: SEL.approve, amountWei: '100' }, g, SELF);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const decoded = decodeCall(res.target, res.value, res.data);
    expect(decoded.reject).toBeUndefined();
    const c = classify(decoded, g, SELF);
    expect(c.lane).toBe('l1');
  });

  it('refuses an ambiguous spender grant (0 or >1) — never guesses which', () => {
    const zero = grantOf(rule({ spenderSet: [] }));
    expect(buildGovernedCall({ target: TOKEN, selector: SEL.approve, amountWei: '1' }, zero, SELF)).toMatchObject({
      ok: false,
      reason: 'not_authority_determined',
    });
    const many = grantOf(rule({ spenderSet: [SPENDER, ATTACKER] }));
    expect(buildGovernedCall({ target: TOKEN, selector: SEL.approve, amountWei: '1' }, many, SELF)).toMatchObject({
      ok: false,
      reason: 'not_authority_determined',
    });
  });

  it('refuses recipientMode allowlist (which of N payees? — not determinable)', () => {
    const g = grantOf(rule({ selector: SEL.transfer, recipientMode: 'allowlist' }));
    expect(buildGovernedCall({ target: TOKEN, selector: SEL.transfer, amountWei: '1' }, g, SELF)).toMatchObject({
      ok: false,
      reason: 'not_authority_determined',
    });
  });

  it('refuses free non-authority-arg selectors (swap route/minOut/deadline) in v1', () => {
    const g = grantOf(rule({ target: VAULT, selector: SEL.swap }));
    expect(buildGovernedCall({ target: VAULT, selector: SEL.swap, amountWei: '1' }, g, SELF)).toMatchObject({
      ok: false,
      reason: 'not_authority_determined',
    });
  });

  it('refuses setApprovalForAll (bool is not authority-determined; true is banned anyway)', () => {
    const g = grantOf(rule({ selector: SEL.setApprovalForAll }));
    expect(buildGovernedCall({ target: TOKEN, selector: SEL.setApprovalForAll, amountWei: '1' }, g, SELF)).toMatchObject({
      ok: false,
      reason: 'not_authority_determined',
    });
  });

  it('refuses an ungranted (target,selector) — no grant, nothing to build from', () => {
    const g = grantOf(rule({}));
    expect(buildGovernedCall({ target: VAULT, selector: SEL.approve, amountWei: '1' }, g, SELF)).toMatchObject({
      ok: false,
      reason: 'no_grant',
    });
  });

  it('refuses a non-positive / malformed amount', () => {
    const g = grantOf(rule({}));
    expect(buildGovernedCall({ target: TOKEN, selector: SEL.approve, amountWei: '0' }, g, SELF)).toMatchObject({
      ok: false,
      reason: 'bad_amount',
    });
    expect(buildGovernedCall({ target: TOKEN, selector: SEL.approve, amountWei: 'notanumber' }, g, SELF)).toMatchObject({
      ok: false,
      reason: 'bad_amount',
    });
  });

  it('refuses an unknown selector outright', () => {
    const g = grantOf(rule({}));
    expect(buildGovernedCall({ target: TOKEN, selector: '0xdeadbeef', amountWei: '1' }, g, SELF)).toMatchObject({
      ok: false,
      reason: 'unknown_selector',
    });
  });
});
