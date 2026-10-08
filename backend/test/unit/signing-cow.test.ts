import { describe, it, expect } from 'vitest';
import { hashTypedData, keccak256, toBytes } from 'viem';
import {
  assertDescriptor,
  DescriptorError,
  descriptorTypeHash,
  onChainGrantParams,
  defaultSigningRegistry,
} from '../../src/signing/intent-registry.js';
import { classifySigning } from '../../src/signing/intent-classify.js';
import { buildIntent } from '../../src/signing/intent-builder.js';
import type { SigningDescriptor, SigningGrantState, SigningRule } from '../../src/signing/types.js';

/**
 * Stage F′ FP-4 Slice-4 — CoW GPv2Order off-chain engine. Proves: the §3a `preHashedConstant` N-02 override
 * (gated, leaf-invariant preserved); the GENUINE (non-circular) `typeHash == ORDER_TYPE_HASH`; the builder's
 * 12 pinned leaves (three pre-hashed words) + `digest == viem hashTypedData(real Order)`; hostile `ctx.pins`
 * ignored; missing `buyAmount` → `missing_pin`; classify (no new_spender for order, over_cap on sell+fee);
 * the route 422 on token mismatch is covered in the route suite.
 */

const ORDER_TYPE_HASH = '0xd5a25ba2e97094ad7d83dc28a6572da797d6b3e7fc6663bd93efb789fc17e489';
const ACCOUNT = '0x00000000000000000000000000000000000000ff';
const SELL = '0xfff9976782d46cc05630d1f6ebab18b2324d6b14'; // Sepolia WETH
const BUY = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238'; // Sepolia USDC
const SETTLEMENT = '0x9008d19f58aabd9ed0d60971565aa8510560ab41';

/** A minimal, hand-built CoW order descriptor (chainId Sepolia) — distinct from the seeded registry row so
 *  the test owns its exact shape for the N-02-override permutations. */
function cowDescriptor(overrides: Partial<SigningDescriptor> = {}): SigningDescriptor {
  return {
    descriptorId: 30,
    key: 'cow.order.test',
    label: 'CoW sell order',
    protocol: 'CoW Protocol GPv2Order',
    domain: { name: 'Gnosis Protocol', version: 'v2', chainId: 11155111, verifyingContract: SETTLEMENT },
    primaryType: 'Order',
    kind: 'order',
    fields: [
      { name: 'sellToken', type: 'address' },
      { name: 'buyToken', type: 'address' },
      { name: 'receiver', type: 'address' },
      { name: 'sellAmount', type: 'uint256' },
      { name: 'buyAmount', type: 'uint256' },
      { name: 'validTo', type: 'uint32' },
      { name: 'appData', type: 'bytes32' },
      { name: 'feeAmount', type: 'uint256' },
      { name: 'kind', type: 'string', preHashedConstant: true },
      { name: 'partiallyFillable', type: 'bool' },
      { name: 'sellTokenBalance', type: 'string', preHashedConstant: true },
      { name: 'buyTokenBalance', type: 'string', preHashedConstant: true },
    ],
    roles: { amount: 'sellAmount', deadline: 'validTo' },
    orderRoles: { receiver: 'receiver', fee: 'feeAmount', sellToken: 'sellToken' },
    constantPins: {
      sellToken: SELL,
      buyToken: BUY,
      feeAmount: 0n,
      appData: '0x0000000000000000000000000000000000000000000000000000000000000000',
      kind: 'sell',
      partiallyFillable: false,
      sellTokenBalance: 'erc20',
      buyTokenBalance: 'erc20',
    },
    sensitive: false,
    ...overrides,
  };
}

function orderRule(overrides: Partial<SigningRule> = {}): SigningRule {
  return {
    descriptorId: 30,
    spenderSet: [], // order has no spender
    perIntentCap: '100000000000000000000', // 100e18
    maxDeadlineWindow: 3600,
    token: SELL,
    active: true,
    ...overrides,
  };
}

function grant(rule: SigningRule): SigningGrantState {
  return { rules: new Map([[rule.descriptorId, rule]]), signingEpoch: 0 };
}

describe('CoW descriptor — N-02 override (§3a) is gated and leaf-invariant', () => {
  it('accepts the well-formed CoW order descriptor with three gated pre-hashed enum fields', () => {
    expect(() => assertDescriptor(cowDescriptor())).not.toThrow();
  });

  it('rejects a `string` field WITHOUT preHashedConstant (dynamic_field)', () => {
    const d = cowDescriptor();
    d.fields[8] = { name: 'kind', type: 'string' }; // flag dropped
    expect(() => assertDescriptor(d)).toThrowError(DescriptorError);
    try {
      assertDescriptor(d);
    } catch (e) {
      expect((e as DescriptorError).code).toBe('dynamic_field');
    }
  });

  it('rejects a preHashedConstant field with NO constantPins entry (dynamic_field)', () => {
    const d = cowDescriptor();
    const pins = { ...(d.constantPins ?? {}) };
    delete pins['kind'];
    d.constantPins = pins;
    // missing_constant_pin OR dynamic_field — both are fail-closed; assert it throws.
    expect(() => assertDescriptor(d)).toThrowError(DescriptorError);
  });

  it('rejects a preHashedConstant field on a NON-order descriptor (dynamic_field)', () => {
    const d = cowDescriptor({ kind: 'flat' });
    expect(() => assertDescriptor(d)).toThrowError(DescriptorError);
    try {
      assertDescriptor(d);
    } catch (e) {
      expect((e as DescriptorError).code).toBe('dynamic_field');
    }
  });

  it('rejects an order with the wrong field count', () => {
    const d = cowDescriptor();
    d.fields = d.fields.slice(0, 11);
    expect(() => assertDescriptor(d)).toThrowError(DescriptorError);
  });

  it('rejects an order that carries a spender role (I-1)', () => {
    const d = cowDescriptor();
    d.roles = { ...d.roles, spender: 'receiver' };
    expect(() => assertDescriptor(d)).toThrowError(DescriptorError);
  });
});

describe('CoW descriptor — genuine (non-circular) typeHash', () => {
  it('descriptorTypeHash reproduces CoW ORDER_TYPE_HASH (string type declarations, not a bytes32 self-check)', () => {
    expect(descriptorTypeHash(cowDescriptor())).toBe(ORDER_TYPE_HASH);
  });

  it('onChainGrantParams emits kind=1, spenderIndex=0xFF, buyToken, and the fixed indices', () => {
    const p = onChainGrantParams(cowDescriptor());
    expect(p.kind).toBe(1);
    expect(p.spenderIndex).toBe(255);
    expect(p.amountIndex).toBe(3);
    expect(p.deadlineIndex).toBe(5);
    expect(p.numFields).toBe(12);
    expect(p.typeHash).toBe(ORDER_TYPE_HASH);
    expect(p.buyToken).toBe(BUY);
    expect(p.nestedTypeHash).toBe('0x0000000000000000000000000000000000000000000000000000000000000000');
    expect(p.expiryLeafIndex).toBe(255);
  });

  it('the seeded registry row (id 30) matches the real ORDER_TYPE_HASH', () => {
    const d = defaultSigningRegistry.get(30);
    expect(d).toBeDefined();
    expect(descriptorTypeHash(d!)).toBe(ORDER_TYPE_HASH);
  });
});

describe('CoW buildIntent — pinned leaves + viem oracle', () => {
  const ctx = { self: ACCOUNT, nowSec: 1_700_000_000, windowSec: 1800, pins: { buyAmount: 1000000000n } };

  it('produces 12 leaves with the three pre-hashed enum words + digest == viem hashTypedData(real Order)', () => {
    const d = cowDescriptor();
    const r = buildIntent(d, orderRule(), { amountWei: '60000000000000000000', ctx });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields.length).toBe(12);
    // the three pre-hashed string leaves are the pinned words, not dynamic ABI blobs.
    expect(r.fields[8]).toBe(keccak256(toBytes('sell')));
    expect(r.fields[10]).toBe(keccak256(toBytes('erc20')));
    expect(r.fields[11]).toBe(keccak256(toBytes('erc20')));
    // the receiver leaf is self (owner-field self-pin), sellToken/buyToken the reviewed constants.
    expect(r.fields[2]).toBe(`0x${'0'.repeat(24)}${ACCOUNT.slice(2)}`);
    // the GENUINE viem oracle: `r.typedData` carries the REAL Order typed-data (string-typed enum fields,
    // plain string values 'sell'/'erc20'), so viem computes keccak256("sell") itself — a true match, not a
    // bytes32 self-check. Equality proves the pre-hashed leaf word == viem's own string encoding.
    const viemDigest = hashTypedData(r.typedData as Parameters<typeof hashTypedData>[0]);
    expect(r.digest).toBe(viemDigest);
  });

  it('ignores a hostile ctx.pins override of a reviewed constant (buyToken/receiver)', () => {
    const d = cowDescriptor();
    const r = buildIntent(d, orderRule(), {
      amountWei: '10000000000000000000',
      ctx: { ...ctx, pins: { buyAmount: 1n, buyToken: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', receiver: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' } },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields[1]).toBe(`0x${'0'.repeat(24)}${BUY.slice(2)}`); // reviewed buyToken, not the hostile pin
    expect(r.fields[2]).toBe(`0x${'0'.repeat(24)}${ACCOUNT.slice(2)}`); // self, not the hostile pin
  });

  it('fails closed (missing_pin) when buyAmount is absent', () => {
    const d = cowDescriptor();
    const r = buildIntent(d, orderRule(), { amountWei: '10000000000000000000', ctx: { self: ACCOUNT, nowSec: 1_700_000_000, windowSec: 1800 } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('missing_pin');
  });
});

describe('CoW classifySigning', () => {
  const now = 1_700_000_000;
  const deadline = now + 600;

  it('L1 when within grant (no spender needed for order)', () => {
    const c = classifySigning(
      { descriptorId: 30, spender: '0x0000000000000000000000000000000000000000', amountWei: '60000000000000000000', deadlineSec: deadline },
      cowDescriptor(),
      grant(orderRule()),
      now,
    );
    expect(c.lane).toBe('l1');
  });

  it('L3 over_cap when sellAmount+feeAmount exceeds cap (fee folded in)', () => {
    const d = cowDescriptor({ constantPins: { ...cowDescriptor().constantPins, feeAmount: 50000000000000000000n } });
    const c = classifySigning(
      { descriptorId: 30, spender: '0x0000000000000000000000000000000000000000', amountWei: '60000000000000000000', deadlineSec: deadline },
      d,
      grant(orderRule()),
      now,
    );
    expect(c.lane).toBe('l3_widen');
    if (c.lane === 'l3_widen') expect(c.reasons).toContain('over_cap');
  });

  it('never yields new_spender for an order with an empty spender set', () => {
    const c = classifySigning(
      { descriptorId: 30, spender: '0xabcabcabcabcabcabcabcabcabcabcabcabcabca', amountWei: '10000000000000000000', deadlineSec: deadline },
      cowDescriptor(),
      grant(orderRule()),
      now,
    );
    expect(c.lane).toBe('l1'); // a non-granted spender is NOT a widen for order
  });

  it('L3 no_grant when the order rule is absent', () => {
    const c = classifySigning(
      { descriptorId: 30, spender: '0x0000000000000000000000000000000000000000', amountWei: '10000000000000000000', deadlineSec: deadline },
      cowDescriptor(),
      { rules: new Map(), signingEpoch: 0 },
      now,
    );
    expect(c.lane).toBe('l3_widen');
    if (c.lane === 'l3_widen') expect(c.reasons).toContain('no_grant');
  });
});
