import { describe, it, expect } from 'vitest';
import { hashTypedData, keccak256, concat } from 'viem';
import {
  createSigningRegistry,
  assertDescriptor,
  DescriptorError,
  descriptorTypeHash,
  descriptorDomainSeparator,
  onChainGrantParams,
  defaultSigningRegistry,
} from '../../src/signing/intent-registry.js';
import { classifySigning } from '../../src/signing/intent-classify.js';
import { buildIntent } from '../../src/signing/intent-builder.js';
import type { SigningDescriptor, SigningGrantState, SigningRule } from '../../src/signing/types.js';

const ACCOUNT = '0x00000000000000000000000000000000000000ff';
const SPENDER = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x0000000000000000000000000000000000000a11';

const erc2612: SigningDescriptor = {
  descriptorId: 1,
  key: 'erc2612.permit',
  label: 'ERC-2612 permit',
  protocol: 'ERC-2612 Permit',
  domain: { name: 'Tok', version: '1', chainId: 16601, verifyingContract: TOKEN },
  primaryType: 'Permit',
  fields: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  roles: { spender: 'spender', amount: 'value', deadline: 'deadline' },
  nonceRole: 'nonce', // F′-SIGN-1: the ERC-2612 `nonce` leaf is the replay guard (code-enforced).
  sensitive: false,
};

function grant(overrides: Partial<SigningRule> = {}): SigningGrantState {
  const rule: SigningRule = {
    descriptorId: 1,
    spenderSet: [SPENDER],
    perIntentCap: '1000',
    maxDeadlineWindow: 3600,
    token: TOKEN,
    active: true,
    ...overrides,
  };
  return { rules: new Map([[1, rule]]), signingEpoch: 0 };
}

describe('intent-registry — N-01/N-02 descriptor review (fail-closed engine assertions)', () => {
  it('accepts a well-formed static descriptor', () => {
    expect(() => assertDescriptor(erc2612)).not.toThrow();
  });

  it('N-01: rejects a domain that does not bind chainId', () => {
    const bad = { ...erc2612, domain: { ...erc2612.domain, chainId: 0 } };
    expect(() => assertDescriptor(bad)).toThrowError(DescriptorError);
    try {
      assertDescriptor(bad);
    } catch (e) {
      expect((e as DescriptorError).code).toBe('domain_unbound_chainid');
    }
  });

  it('N-01: rejects a domain that does not bind verifyingContract', () => {
    const bad = { ...erc2612, domain: { ...erc2612.domain, verifyingContract: '0x0000000000000000000000000000000000000000' } };
    expect(() => assertDescriptor(bad)).toThrowError(/verifyingContract/);
  });

  it('N-02: rejects a dynamic field (string)', () => {
    const bad: SigningDescriptor = {
      ...erc2612,
      fields: [...erc2612.fields, { name: 'memo', type: 'string' }],
    };
    expect(() => assertDescriptor(bad)).toThrowError(/static 32-byte word/);
  });

  it('N-02: rejects an array field', () => {
    const bad: SigningDescriptor = { ...erc2612, fields: [...erc2612.fields, { name: 'ids', type: 'uint256[]' }] };
    expect(() => assertDescriptor(bad)).toThrowError(DescriptorError);
  });

  it('rejects role indices that alias (deadline read as amount)', () => {
    const bad: SigningDescriptor = { ...erc2612, roles: { spender: 'spender', amount: 'deadline', deadline: 'deadline' } };
    expect(() => assertDescriptor(bad)).toThrowError(/distinct/);
  });

  it('rejects a spender role field that is not an address', () => {
    const bad: SigningDescriptor = { ...erc2612, roles: { spender: 'value', amount: 'value', deadline: 'deadline' } };
    expect(() => assertDescriptor(bad)).toThrowError(DescriptorError);
  });

  it('createSigningRegistry asserts every descriptor (a bad one throws at construction)', () => {
    const bad = { ...erc2612, domain: { ...erc2612.domain, chainId: 0 } };
    expect(() => createSigningRegistry([bad])).toThrowError(DescriptorError);
  });

  it('the default built-in registry is valid', () => {
    expect(defaultSigningRegistry.list().length).toBeGreaterThan(0);
  });
});

describe('intent-builder — digest matches viem hashTypedData AND the on-chain reconstruction', () => {
  it('the built digest equals viem hashTypedData (the oracle a real protocol uses)', () => {
    const r = buildIntent(erc2612, grant().rules.get(1), {
      amountWei: '500',
      spender: SPENDER,
      ctx: { self: ACCOUNT, nowSec: 1_000_000, windowSec: 1800, pins: { nonce: 7 } },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const viemDigest = hashTypedData({
      domain: { name: 'Tok', version: '1', chainId: 16601, verifyingContract: TOKEN },
      types: { Permit: erc2612.fields },
      primaryType: 'Permit',
      message: r.typedData.message,
    });
    expect(r.digest).toBe(viemDigest);
  });

  it('the built digest equals the raw on-chain reconstruction keccak(0x1901 ‖ sep ‖ keccak(typeHash ‖ fields))', () => {
    const r = buildIntent(erc2612, grant().rules.get(1), {
      amountWei: '500',
      spender: SPENDER,
      ctx: { self: ACCOUNT, nowSec: 1_000_000, windowSec: 1800, pins: { nonce: 7 } },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const structHash = keccak256(concat([descriptorTypeHash(erc2612), ...r.fields]));
    const digest = keccak256(concat(['0x1901', descriptorDomainSeparator(erc2612), structHash]));
    expect(r.digest).toBe(digest);
    expect(r.fields.length).toBe(5);
  });

  it('onChainGrantParams reports the indices the owner tx stores', () => {
    const p = onChainGrantParams(erc2612);
    expect(p).toMatchObject({ descriptorId: 1, numFields: 5, spenderIndex: 1, amountIndex: 2, deadlineIndex: 4 });
    expect(p.domainSeparator).toBe(descriptorDomainSeparator(erc2612));
    expect(p.typeHash).toBe(descriptorTypeHash(erc2612));
  });
});

describe('intent-builder — bytesN pins are exact-width (FP-2 FP-CARRY-5, fail-closed)', () => {
  // a descriptor with an extra static bytes32 field, pinned server-side (non-role).
  const withSalt: SigningDescriptor = { ...erc2612, fields: [...erc2612.fields, { name: 'salt', type: 'bytes32' }] };
  const bytes32 = '0x' + 'ab'.repeat(32); // exactly 32 bytes

  it('accepts a correctly-sized bytes32 pin', () => {
    const r = buildIntent(withSalt, grant().rules.get(1), {
      amountWei: '500',
      spender: SPENDER,
      ctx: { self: ACCOUNT, nowSec: 1_000_000, windowSec: 1800, pins: { nonce: 7, salt: bytes32 } },
    });
    expect(r.ok).toBe(true);
  });

  it('refuses a too-short bytesN pin (would silently right-pad) → bad_pin', () => {
    const r = buildIntent(withSalt, grant().rules.get(1), {
      amountWei: '500',
      spender: SPENDER,
      ctx: { self: ACCOUNT, nowSec: 1_000_000, windowSec: 1800, pins: { nonce: 7, salt: '0xabab' } },
    });
    expect(r).toEqual({ ok: false, reason: 'bad_pin' });
  });

  it('refuses a too-long bytesN pin → bad_pin', () => {
    const r = buildIntent(withSalt, grant().rules.get(1), {
      amountWei: '500',
      spender: SPENDER,
      ctx: { self: ACCOUNT, nowSec: 1_000_000, windowSec: 1800, pins: { nonce: 7, salt: '0x' + 'ab'.repeat(33) } },
    });
    expect(r).toEqual({ ok: false, reason: 'bad_pin' });
  });
});

describe('intent-builder — never-guess-money (authority pinned from grant state, not model text)', () => {
  it('pins the deadline server-side (now + window), ignoring any model deadline', () => {
    const r = buildIntent(erc2612, grant().rules.get(1), {
      amountWei: '10',
      spender: SPENDER,
      ctx: { self: ACCOUNT, nowSec: 2_000_000, windowSec: 600, pins: { nonce: 0 } },
    });
    expect(r.ok && r.deadlineSec).toBe(2_000_600);
  });

  it('pins the owner field to self (confused-deputy guard)', () => {
    const r = buildIntent(erc2612, grant().rules.get(1), {
      amountWei: '10',
      spender: SPENDER,
      ctx: { self: ACCOUNT, nowSec: 1, windowSec: 60, pins: { nonce: 0 } },
    });
    expect(r.ok && (r.typedData.message['owner'] as string)).toBe(ACCOUNT.toLowerCase());
  });

  it('refuses a spender outside the owner grant set (never a novel spender)', () => {
    const r = buildIntent(erc2612, grant().rules.get(1), {
      amountWei: '10',
      spender: '0x9999999999999999999999999999999999999999',
      ctx: { self: ACCOUNT, nowSec: 1, windowSec: 60, pins: { nonce: 0 } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('spender_unresolved');
  });

  it('stands down when a non-role field has no server pin (never fabricates)', () => {
    const r = buildIntent(erc2612, grant().rules.get(1), {
      amountWei: '10',
      spender: SPENDER,
      ctx: { self: ACCOUNT, nowSec: 1, windowSec: 60 }, // no nonce pin
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('missing_pin');
  });

  it('decodes a human-readable card, never a raw blob (00 §9)', () => {
    const r = buildIntent(erc2612, grant().rules.get(1), {
      amountWei: '500',
      spender: SPENDER,
      ctx: { self: ACCOUNT, nowSec: 1, windowSec: 1800, pins: { nonce: 1 } },
    });
    expect(r.ok && r.humanReadable).toMatch(/ERC-2612 Permit/);
    expect(r.ok && r.humanReadable).toMatch(/500/);
  });
});

describe('intent-classify — three-lane (L1 / L2 JIT / L3 widen) + the default-deny floor', () => {
  const NOW = 1_000_000;
  const base = { descriptorId: 1, spender: SPENDER, amountWei: '500', deadlineSec: NOW + 1800 };

  it('L1: in-policy, non-sensitive → silent', () => {
    expect(classifySigning(base, erc2612, grant(), NOW)).toEqual({ lane: 'l1', reason: 'in_policy' });
  });

  it('L2: a sensitive descriptor ALWAYS asks (00 §6c), even in policy', () => {
    const sensitive = { ...erc2612, sensitive: true };
    const c = classifySigning(base, sensitive, grant(), NOW);
    expect(c).toEqual({ lane: 'l2', triggers: ['sensitive'] });
  });

  it('forbidden: unknown descriptor is REFUSED, never inferred (00 §9 floor)', () => {
    expect(classifySigning(base, undefined, grant(), NOW)).toEqual({ lane: 'forbidden', reason: 'unknown_descriptor' });
  });

  it('L3 widen: no standing grant', () => {
    const c = classifySigning(base, erc2612, { rules: new Map(), signingEpoch: 0 }, NOW);
    expect(c).toEqual({ lane: 'l3_widen', reasons: ['no_grant'] });
  });

  it('L3 widen: over the per-intent cap', () => {
    const c = classifySigning({ ...base, amountWei: '5000' }, erc2612, grant(), NOW);
    expect(c.lane).toBe('l3_widen');
    if (c.lane === 'l3_widen') expect(c.reasons).toContain('over_cap');
  });

  it('L3 widen: a new spender', () => {
    const c = classifySigning({ ...base, spender: '0x2222222222222222222222222222222222222222' }, erc2612, grant(), NOW);
    expect(c.lane).toBe('l3_widen');
    if (c.lane === 'l3_widen') expect(c.reasons).toContain('new_spender');
  });

  it('L3 widen: a deadline beyond the granted window', () => {
    const c = classifySigning({ ...base, deadlineSec: NOW + 999_999 }, erc2612, grant(), NOW);
    expect(c.lane).toBe('l3_widen');
    if (c.lane === 'l3_widen') expect(c.reasons).toContain('deadline_too_far');
  });

  it('forbidden: a deadline in the past is malformed', () => {
    const c = classifySigning({ ...base, deadlineSec: NOW - 1 }, erc2612, grant(), NOW);
    expect(c).toEqual({ lane: 'forbidden', reason: 'malformed_intent' });
  });

  it('a removed (inactive) rule is default-deny → L3 widen', () => {
    const c = classifySigning(base, erc2612, grant({ active: false }), NOW);
    expect(c).toEqual({ lane: 'l3_widen', reasons: ['no_grant'] });
  });
});
