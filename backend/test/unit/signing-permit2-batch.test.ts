import { describe, it, expect } from 'vitest';
import { hashTypedData } from 'viem';
import {
  assertDescriptor,
  DescriptorError,
  descriptorTypeHash,
  onChainGrantParams,
  defaultSigningRegistry,
} from '../../src/signing/intent-registry.js';
import { classifySigning } from '../../src/signing/intent-classify.js';
import { buildBatchIntent } from '../../src/signing/intent-builder.js';
import { permit2BatchDescriptor, PERMIT2_ADDRESS } from '../../src/signing/descriptors.js';
import type { SigningDescriptor, SigningGrantState, SigningRule } from '../../src/signing/types.js';

/**
 * Stage F′ FP-4 Slice-5 — Permit2 `PermitBatchTransferFrom` off-chain engine. Proves: the batch
 * `assertDescriptor` accept/reject matrix (array group, TokenPermissions subFields, 4 top members, tokenCaps
 * hygiene, N-02 intact / no preHashedConstant); the GENUINE (non-circular) `descriptorTypeHash == PBTF`; the
 * `buildBatchIntent` 2N+3 pinned leaves + `digest == viem hashTypedData(real PermitBatchTransferFrom)` +
 * model-token-∉-caps rejected + missing-nonce `missing_pin`; per-token classify; `onChainGrantParams`.
 */

const PBTF_TYPEHASH_PUBLISHED = '0xfcf35f5ac6a2c28868dc44c302166470266239195f02b0ee408334829333b766';
const USDC = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238'; // Sepolia USDC (6dp in reality; caps are base-units)
const WETH = '0xfff9976782d46cc05630d1f6ebab18b2324d6b14'; // Sepolia WETH
const OTHER = '0x00000000000000000000000000000000000000cc'; // not in the allowlist
const SPENDER = '0x00000000000000000000000000000000000000aa';

function batchDescriptor(): SigningDescriptor {
  return permit2BatchDescriptor(40, 'permit2.batch.test', 11155111, [
    { token: USDC, cap: '1000000000' },
    { token: WETH, cap: '1000000000000000000' },
  ]);
}

function rule(overrides: Partial<SigningRule> = {}): SigningRule {
  return {
    descriptorId: 40,
    spenderSet: [SPENDER],
    perIntentCap: '0',
    maxDeadlineWindow: 3600,
    token: USDC,
    tokenCaps: [
      { token: USDC, cap: '1000000000' },
      { token: WETH, cap: '1000000000000000000' },
    ],
    active: true,
    ...overrides,
  };
}

function grant(r: SigningRule | null): SigningGrantState {
  const rules = new Map<number, SigningRule>();
  if (r) rules.set(40, r);
  return { rules, signingEpoch: 0 };
}

describe('FP-4 Slice-5 — batch assertDescriptor', () => {
  it('accepts a well-formed batch descriptor', () => {
    expect(() => assertDescriptor(batchDescriptor())).not.toThrow();
  });

  it('rejects a non-array nested group', () => {
    const d = batchDescriptor();
    d.nested!.array = false;
    expect(() => assertDescriptor(d)).toThrow(DescriptorError);
  });

  it('rejects wrong TokenPermissions subFields', () => {
    const d = batchDescriptor();
    d.nested!.subFields = [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }];
    expect(() => assertDescriptor(d)).toThrow(DescriptorError);
  });

  it('rejects an empty tokenCaps allowlist', () => {
    const d = batchDescriptor();
    d.tokenCaps = [];
    expect(() => assertDescriptor(d)).toThrow(/tokenCaps/);
  });

  it('rejects a duplicate token in tokenCaps', () => {
    const d = batchDescriptor();
    d.tokenCaps = [{ token: USDC, cap: '1' }, { token: USDC, cap: '2' }];
    expect(() => assertDescriptor(d)).toThrow(/duplicate/);
  });

  it('rejects a zero cap in tokenCaps', () => {
    const d = batchDescriptor();
    d.tokenCaps = [{ token: USDC, cap: '0' }];
    expect(() => assertDescriptor(d)).toThrow(/positive/);
  });

  it('rejects a batch carrying a preHashedConstant leaf (order-only)', () => {
    const d = batchDescriptor();
    d.fields[1] = { name: 'spender', type: 'string', preHashedConstant: true };
    expect(() => assertDescriptor(d)).toThrow(DescriptorError);
  });

  it('rejects wrong top-member shape', () => {
    const d = batchDescriptor();
    d.fields = [d.fields[0]!, { name: 'nonce', type: 'uint256' }, { name: 'spender', type: 'address' }, { name: 'deadline', type: 'uint256' }];
    expect(() => assertDescriptor(d)).toThrow(DescriptorError);
  });

  it('the seeded registry batch descriptor (id 40) is valid', () => {
    expect(defaultSigningRegistry.get(40)?.kind).toBe('batch');
  });
});

describe('FP-4 Slice-5 — genuine typeHash + onChainGrantParams', () => {
  it('descriptorTypeHash equals the published PermitBatchTransferFrom typehash (non-circular)', () => {
    expect(descriptorTypeHash(batchDescriptor()).toLowerCase()).toBe(PBTF_TYPEHASH_PUBLISHED);
  });

  it('onChainGrantParams emits kind=2, 0xFF scalar indices, the TokenPermissions fold, caps + hash', () => {
    const p = onChainGrantParams(batchDescriptor());
    expect(p.kind).toBe(2);
    expect(p.spenderIndex).toBe(255);
    expect(p.amountIndex).toBe(255);
    expect(p.deadlineIndex).toBe(255);
    expect(p.expiryLeafIndex).toBe(255);
    expect(p.numFields).toBe(4);
    expect(p.nestedLeafStart).toBe(0);
    expect(p.nestedLeafCount).toBe(2);
    expect(p.typeHash.toLowerCase()).toBe(PBTF_TYPEHASH_PUBLISHED);
    expect(p.tokenCaps.length).toBe(2);
    expect(p.tokenCapsHash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('FP-4 Slice-5 — buildBatchIntent', () => {
  const ctx = { nowSec: 1_700_000_000, windowSec: 1800, nonce: 42 };

  it('produces 2N+3 pinned leaves and a digest == viem hashTypedData(real PBTF)', () => {
    const d = batchDescriptor();
    const r = buildBatchIntent(d, rule(), {
      permits: [{ token: USDC, amountWei: '500000000' }, { token: WETH, amountWei: '250000000000000000' }],
      spender: SPENDER,
      ctx,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields.length).toBe(2 * 2 + 3); // 2N+3 = 7
    const viemDigest = hashTypedData({
      domain: { name: 'Permit2', chainId: 11155111, verifyingContract: PERMIT2_ADDRESS },
      types: {
        PermitBatchTransferFrom: [
          { name: 'permitted', type: 'TokenPermissions[]' },
          { name: 'spender', type: 'address' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
        TokenPermissions: [
          { name: 'token', type: 'address' },
          { name: 'amount', type: 'uint256' },
        ],
      },
      primaryType: 'PermitBatchTransferFrom',
      message: {
        permitted: [
          { token: USDC, amount: 500000000n },
          { token: WETH, amount: 250000000000000000n },
        ],
        spender: SPENDER,
        nonce: 42n,
        deadline: BigInt(ctx.nowSec + ctx.windowSec),
      },
    });
    expect(r.digest).toBe(viemDigest);
  });

  it('rejects a model-supplied token ∉ tokenCaps (never signed — N-01)', () => {
    const r = buildBatchIntent(batchDescriptor(), rule(), {
      permits: [{ token: OTHER, amountWei: '1' }],
      spender: SPENDER,
      ctx,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_grant');
  });

  it('stands down on a missing nonce pin (never model text)', () => {
    const r = buildBatchIntent(batchDescriptor(), rule(), {
      permits: [{ token: USDC, amountWei: '1' }],
      spender: SPENDER,
      ctx: { nowSec: ctx.nowSec, windowSec: ctx.windowSec },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('missing_pin');
  });

  it('rejects a spender outside the owner grant', () => {
    const r = buildBatchIntent(batchDescriptor(), rule(), {
      permits: [{ token: USDC, amountWei: '1' }],
      spender: OTHER,
      ctx,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('spender_unresolved');
  });

  it('accumulates per-token Σ in the debits (token-keyed)', () => {
    const r = buildBatchIntent(batchDescriptor(), rule(), {
      permits: [{ token: USDC, amountWei: '100' }, { token: WETH, amountWei: '5' }, { token: USDC, amountWei: '50' }],
      spender: SPENDER,
      ctx,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const usdc = r.debits.find((x) => x.token === USDC.toLowerCase());
    expect(usdc?.amountWei).toBe('150'); // 100 + 50 keyed by token
  });
});

describe('FP-4 Slice-5 — classify (per-token)', () => {
  const now = 1_700_000_000;
  const base = { descriptorId: 40, spender: SPENDER, amountWei: '0', deadlineSec: now + 600 };

  it('in-policy multi-token ⇒ L1', () => {
    const c = classifySigning(
      { ...base, permits: [{ token: USDC, amountWei: '500000000' }, { token: WETH, amountWei: '1' }] },
      batchDescriptor(),
      grant(rule()),
      now,
    );
    expect(c.lane).toBe('l1');
  });

  it('one token Σ over its cap ⇒ L3 over_cap', () => {
    const c = classifySigning(
      { ...base, permits: [{ token: USDC, amountWei: '2000000000' }] },
      batchDescriptor(),
      grant(rule()),
      now,
    );
    expect(c.lane).toBe('l3_widen');
    if (c.lane === 'l3_widen') expect(c.reasons).toContain('over_cap');
  });

  it('a token ∉ the allowlist ⇒ L3 over_cap', () => {
    const c = classifySigning(
      { ...base, permits: [{ token: OTHER, amountWei: '1' }] },
      batchDescriptor(),
      grant(rule()),
      now,
    );
    expect(c.lane).toBe('l3_widen');
  });

  it('a spender outside the set ⇒ L3 new_spender', () => {
    const c = classifySigning(
      { ...base, spender: OTHER, permits: [{ token: USDC, amountWei: '1' }] },
      batchDescriptor(),
      grant(rule()),
      now,
    );
    expect(c.lane).toBe('l3_widen');
    if (c.lane === 'l3_widen') expect(c.reasons).toContain('new_spender');
  });

  it('no standing grant ⇒ L3 no_grant', () => {
    const c = classifySigning(
      { ...base, permits: [{ token: USDC, amountWei: '1' }] },
      batchDescriptor(),
      grant(null),
      now,
    );
    expect(c.lane).toBe('l3_widen');
    if (c.lane === 'l3_widen') expect(c.reasons).toContain('no_grant');
  });
});
