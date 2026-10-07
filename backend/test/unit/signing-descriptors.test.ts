import { describe, it, expect } from 'vitest';
import { hashTypedData, keccak256, toBytes } from 'viem';
import {
  assertDescriptor,
  descriptorDomainSeparator,
  descriptorTypeHash,
  buildIntent,
  onChainGrantParams,
  defaultSigningRegistry,
  type SigningRule,
} from '../../src/signing/index.js';
import { FP3_DESCRIPTORS, USDC_ONCHAIN_DOMAIN_SEPARATOR, PERMIT2_ADDRESS } from '../../src/signing/descriptors.js';

/**
 * FP-3 — the REAL per-chain descriptor seed proofs. Every descriptor passes the N-01/N-02 engine
 * assertions; each USDC ERC-2612 descriptor's computed domainSeparator equals the token's LIVE
 * on-chain `DOMAIN_SEPARATOR()` (so a wrong name/version can never silently ship — N-01 / R-4); and
 * the Permit2 nested descriptor's reconstructed digest equals viem `hashTypedData` for the REAL
 * PermitSingle typed-data (the oracle a protocol uses — R-4 cap↔digest coupling, off-chain half).
 */

const NOW = 1_700_000_000;

function ruleFor(descriptorId: number, spender: string, token: string): SigningRule {
  return {
    descriptorId,
    spenderSet: [spender.toLowerCase()],
    perIntentCap: '1000000000000',
    maxDeadlineWindow: 3600,
    token: token.toLowerCase(),
    active: true,
  };
}

describe('FP-3 real descriptor seed', () => {
  it('every seeded descriptor passes N-01/N-02 assertDescriptor', () => {
    for (const d of FP3_DESCRIPTORS) expect(() => assertDescriptor(d)).not.toThrow();
  });

  it('seeded descriptors are registered + listed with onChainGrant params', () => {
    for (const d of FP3_DESCRIPTORS) {
      expect(defaultSigningRegistry.get(d.descriptorId)?.key).toBe(d.key);
    }
    const listed = defaultSigningRegistry.list();
    expect(listed.length).toBe(1 + FP3_DESCRIPTORS.length); // FP-2 built-in (id 1) + FP-3 seed
  });

  it('each USDC ERC-2612 descriptor computes the LIVE on-chain DOMAIN_SEPARATOR (N-01 / R-4)', () => {
    for (const [id, expected] of Object.entries(USDC_ONCHAIN_DOMAIN_SEPARATOR)) {
      const d = defaultSigningRegistry.get(Number(id))!;
      expect(descriptorDomainSeparator(d)).toBe(expected);
    }
  });

  it('Permit2 PermitSingle descriptor stores the canonical Permit2 typeHash + domain', () => {
    const permit2TypeHash = keccak256(
      toBytes(
        'PermitSingle(PermitDetails details,address spender,uint256 sigDeadline)PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)',
      ),
    );
    const d = defaultSigningRegistry.byKey('permit2.single.base')!;
    expect(descriptorTypeHash(d)).toBe(permit2TypeHash);
    expect(d.domain.verifyingContract.toLowerCase()).toBe(PERMIT2_ADDRESS.toLowerCase());
    expect(d.domain.version).toBeUndefined(); // Permit2 domain has NO version
  });

  it('Permit2 nested digest == viem hashTypedData for the real PermitSingle (R-4 oracle)', () => {
    const d = defaultSigningRegistry.byKey('permit2.single.eth')!;
    const self = '0x1111111111111111111111111111111111111111';
    const spender = '0x2222222222222222222222222222222222222222';
    const token = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
    const built = buildIntent(d, ruleFor(d.descriptorId, spender, token), {
      amountWei: '5000000',
      spender,
      ctx: { self, nowSec: NOW, windowSec: 1800, pins: { token, nonce: 0 } },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    // the oracle a real protocol / wallet uses — viem over the SAME typed-data the builder emitted.
    const viemDigest = hashTypedData({
      domain: built.typedData.domain,
      types: built.typedData.types,
      primaryType: built.typedData.primaryType,
      message: built.typedData.message,
    });
    expect(built.digest).toBe(viemDigest);
    // the amount pinned is the NESTED PermitDetails.amount — the leaf the wall caps.
    expect(built.amountWei).toBe('5000000');
  });

  it('ERC-2612 digest == viem hashTypedData for a real USDC permit (flat path unchanged)', () => {
    const d = defaultSigningRegistry.byKey('erc2612.usdc.base')!;
    const self = '0x1111111111111111111111111111111111111111';
    const spender = '0x3333333333333333333333333333333333333333';
    const built = buildIntent(d, ruleFor(d.descriptorId, spender, d.domain.verifyingContract), {
      amountWei: '250000',
      spender,
      ctx: { self, nowSec: NOW, windowSec: 1800, pins: { nonce: 3 } },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const viemDigest = hashTypedData({
      domain: built.typedData.domain,
      types: built.typedData.types,
      primaryType: built.typedData.primaryType,
      message: built.typedData.message,
    });
    expect(built.digest).toBe(viemDigest);
  });

  it('onChainGrantParams emits the fold spec for a nested descriptor', () => {
    const d = defaultSigningRegistry.byKey('permit2.single.arb')!;
    const p = onChainGrantParams(d);
    // leaves: [token, amount, expiration, nonce, spender, sigDeadline]
    expect(p).toMatchObject({
      numFields: 3, // top members: details, spender, sigDeadline
      spenderIndex: 4,
      amountIndex: 1,
      deadlineIndex: 5,
      nestedLeafStart: 0,
      nestedLeafCount: 4,
      expiryLeafIndex: 2,
    });
    expect(p.nestedTypeHash).toBe(keccak256(toBytes('PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)')));
  });
});
