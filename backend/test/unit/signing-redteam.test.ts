import { describe, it, expect } from 'vitest';
import { descriptorDomainSeparator } from '../../src/signing/intent-registry.js';
import { buildIntent } from '../../src/signing/intent-builder.js';
import { classifySigning } from '../../src/signing/intent-classify.js';
import type { SigningDescriptor, SigningGrantState, SigningRule } from '../../src/signing/types.js';

/**
 * FP-2 red-team (FP-c/FP-d off-chain): the engine must never BUILD an intent that
 * redirects authority or silently ladders past budget, and cross-chain/cross-
 * contract replay must be impossible by construction. The on-chain wall is the
 * guarantee; this proves the off-chain engine does not hand a hijacked agent a
 * signable intent it shouldn't have.
 */

const TOKEN = '0x0000000000000000000000000000000000000a11';
const SPENDER = '0x1111111111111111111111111111111111111111';
const ACCOUNT = '0x00000000000000000000000000000000000000ff';

const desc = (chainId: number, vc: string): SigningDescriptor => ({
  descriptorId: 1,
  key: 'erc2612.permit',
  label: 'ERC-2612 permit',
  protocol: 'ERC-2612 Permit',
  domain: { name: 'Tok', version: '1', chainId, verifyingContract: vc },
  primaryType: 'Permit',
  fields: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  roles: { spender: 'spender', amount: 'value', deadline: 'deadline' },
  sensitive: false,
});

const rule: SigningRule = {
  descriptorId: 1,
  spenderSet: [SPENDER],
  perIntentCap: '1000',
  maxDeadlineWindow: 3600,
  token: TOKEN,
  active: true,
};

describe('FP-d — cross-chain / cross-contract replay closed by construction', () => {
  it('the same intent on a different chainId yields a different domainSeparator (no replay)', () => {
    const a = descriptorDomainSeparator(desc(16601, TOKEN));
    const b = descriptorDomainSeparator(desc(8453, TOKEN));
    expect(a).not.toBe(b);
  });

  it('the same intent against a different verifyingContract yields a different separator', () => {
    const a = descriptorDomainSeparator(desc(16601, TOKEN));
    const b = descriptorDomainSeparator(desc(16601, '0x00000000000000000000000000000000000000bb'));
    expect(a).not.toBe(b);
  });

  it('a chainId change changes the built digest (same message, different wall)', () => {
    const build = (chainId: number) =>
      buildIntent(desc(chainId, TOKEN), rule, {
        amountWei: '10',
        spender: SPENDER,
        ctx: { self: ACCOUNT, nowSec: 1, windowSec: 60, pins: { nonce: 0 } },
      });
    const a = build(16601);
    const b = build(8453);
    expect(a.ok && b.ok && a.digest !== b.digest).toBe(true);
  });
});

describe('FP-d — intent laddering caught by the cumulative cap (off-chain classify)', () => {
  const NOW = 1_000_000;
  const grant: SigningGrantState = { rules: new Map([[1, rule]]), signingEpoch: 0 };

  it('each small in-cap sign is L1 but an over-cap one is NEVER silently buildable', () => {
    // in-cap → L1
    const small = classifySigning({ descriptorId: 1, spender: SPENDER, amountWei: '900', deadlineSec: NOW + 60 }, desc(16601, TOKEN), grant, NOW);
    expect(small.lane).toBe('l1');
    // over-cap → L3 widen (the wall would revert OverPerIntentCap; no silent arm).
    const big = classifySigning({ descriptorId: 1, spender: SPENDER, amountWei: '2000', deadlineSec: NOW + 60 }, desc(16601, TOKEN), grant, NOW);
    expect(big.lane).toBe('l3_widen');
    // NOTE: the cumulative per-token budget is enforced ON-CHAIN (signing ≤ calling,
    // FP-1 invariant); classify bounds the single-intent cap, the wall bounds the sum.
  });
});

describe('FP-c — never-guess-money: a hijacked agent cannot redirect or inflate', () => {
  const build = (over: Partial<{ spender: string; amountWei: string }>) =>
    buildIntent(desc(16601, TOKEN), rule, {
      amountWei: over.amountWei ?? '10',
      spender: over.spender ?? SPENDER,
      ctx: { self: ACCOUNT, nowSec: 1, windowSec: 60, pins: { nonce: 0 } },
    });

  it('cannot build with a novel spender (not in the owner set)', () => {
    const r = build({ spender: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
    expect(r.ok).toBe(false);
  });

  it('the owner field is always self, never a model-chosen address', () => {
    const r = build({});
    expect(r.ok && (r.typedData.message['owner'] as string)).toBe(ACCOUNT.toLowerCase());
  });

  it('a non-numeric amount is refused (no fabricated value)', () => {
    const r = build({ amountWei: 'not-a-number' });
    expect(r.ok).toBe(false);
  });
});
