import { encodeAbiParameters, keccak256, concat, type Hex } from 'viem';
import type { Eip712Field, SigningDescriptor, SigningRule } from './types.js';
import {
  toViemDomain,
  descriptorTypeHash,
  descriptorDomainSeparator,
  descriptorLeaves,
  foldSpec,
} from './intent-registry.js';
import { parseSigningAmount } from './amount.js';

/**
 * The never-guess-money intent-builder (FP-2, FP-c) — the Stage-D call-builder
 * discipline extended to EIP-712 typed-data. Given a MINIMAL model intent (which
 * reviewed descriptor + a chargeable amount) it builds the EXACT typed-data the
 * session key will sign, filling EVERY authority field from SERVER-SIDE grant
 * state + server context, NEVER from model text:
 *   - the SPENDER is resolved from the owner's granted spender set (pinned when a
 *     single spender is granted; a proposed spender is accepted only if it is ∈
 *     the owner set — never a novel spender from model reasoning);
 *   - the DEADLINE is server-derived (`nowSec + window`), never model text;
 *   - every NON-role field (owner, nonce, …) is pinned from the server `pins` map
 *     (owner → the account self, nonce → the server-read on-chain nonce) — a field
 *     with no server pin stands the build down rather than fabricate it;
 *   - the model contributes ONLY the chargeable `amountWei` (bounded on-chain by
 *     `perIntentCap`) and which granted descriptor.
 *
 * The produced `fields` array is the ordered `bytes32[]` the on-chain
 * `authorizeSigningIntent` consumes; the `digest` equals the wall's
 * `keccak256(0x1901 ‖ domainSeparator ‖ keccak256(typeHash ‖ fields))` BY
 * CONSTRUCTION (standard EIP-712 for all-static-word structs — N-02). A hijacked
 * agent can thus sign nothing with a redirected spender, nothing over budget, and
 * nothing whose typed-data the owner cannot read.
 */

export interface BuildIntentInput {
  /** the chargeable amount the model proposed, base-units decimal string. */
  amountWei: string;
  /** the spender the agent would authorize (lowercased 0x) — validated ∈ the owner grant. */
  spender?: string;
  /** server context: the account self address + reference time + non-role field pins. */
  ctx: {
    /** the account (LeashAccountV5) address — the permit `owner`/self pins resolve to it. */
    self: string;
    /** reference unix-seconds (server clock) — the deadline is `nowSec + windowSec`. */
    nowSec: number;
    /** the deadline window in seconds (≤ the grant's `maxDeadlineWindow`). */
    windowSec: number;
    /**
     * server-pinned values for NON-role fields, keyed by field name (owner, nonce,
     * …). Each must be a server-controlled value (the account self, an on-chain
     * nonce the server read) — NEVER model text. A missing pin stands the build down.
     */
    pins?: Record<string, string | number | bigint | boolean>;
  };
}

export type BuildIntentResult =
  | {
      ok: true;
      descriptorId: number;
      /** the EIP-712 typed-data the session key signs (also the human-decode source). */
      typedData: {
        domain: ReturnType<typeof toViemDomain>;
        types: Record<string, Eip712Field[]>;
        primaryType: string;
        message: Record<string, unknown>;
      };
      /** the ordered `bytes32[]` words the on-chain `authorizeSigningIntent` consumes. */
      fields: Hex[];
      /** the EIP-712 digest — equals the on-chain reconstruction (N-02 static struct). */
      digest: Hex;
      /** resolved authority values (what was pinned — for classify + the JIT card). */
      spender: string;
      amountWei: string;
      deadlineSec: number;
      /** normie-legible one-liner for the approval card (never a raw blob — 00 §9). */
      humanReadable: string;
    }
  | {
      ok: false;
      reason: 'no_grant' | 'spender_unresolved' | 'missing_pin' | 'bad_amount' | 'bad_pin';
    };

export function buildIntent(descriptor: SigningDescriptor, rule: SigningRule | undefined, input: BuildIntentInput): BuildIntentResult {
  if (!rule || !rule.active) return { ok: false, reason: 'no_grant' };

  const amount = parseSigningAmount(input.amountWei);
  if (amount === null) return { ok: false, reason: 'bad_amount' };

  const spender = resolveSpender(rule, input.spender);
  if (spender === null) return { ok: false, reason: 'spender_unresolved' };

  const self = input.ctx.self.toLowerCase();
  const deadlineSec = input.ctx.nowSec + input.ctx.windowSec;

  // Build the LEAF words (what the session key submits + the wall indexes), pinning each from server
  // state — anything not positively resolvable server-side stands the build down (never model text).
  // The nested member (if any) is expanded in place, so `leaves` is the flat pre-order leaf list.
  const leaves = descriptorLeaves(descriptor);
  const fold = foldSpec(descriptor);
  const coercedByName: Record<string, string | bigint | boolean> = {};
  const words: Hex[] = [];
  for (const f of leaves) {
    let value: string | number | bigint | boolean;
    if (f.name === descriptor.roles.amount) {
      value = amount;
    } else if (f.name === descriptor.roles.deadline) {
      value = BigInt(deadlineSec);
    } else if (descriptor.expiryRole !== undefined && f.name === descriptor.expiryRole) {
      // FP-3 (R-2): the secondary expiry (Permit2 `expiration`) is SERVER-pinned to the same
      // deadline the owner window bounds — never model text, never farther than the signature.
      value = BigInt(deadlineSec);
    } else if (f.name === descriptor.roles.spender) {
      value = spender;
    } else if (f.type === 'address' && isOwnerField(f.name)) {
      // owner/holder/account fields always pin to self (never a confused deputy).
      value = self;
    } else {
      const pin = input.ctx.pins?.[f.name];
      if (pin === undefined) return { ok: false, reason: 'missing_pin' };
      value = pin;
    }
    const coerced = coerce(f.type, value);
    if (coerced === null) return { ok: false, reason: 'bad_pin' };
    coercedByName[f.name] = coerced;
    words.push(encodeAbiParameters([{ type: f.type }], [coerced]));
  }

  const domain = toViemDomain(descriptor.domain);
  // digest reconstruction — EXACTLY the on-chain `_signingStructHash`:
  //   FLAT:   keccak256(typeHash ‖ leaves)
  //   NESTED: fold the sub-struct run into one word, then keccak256(typeHash ‖ top members).
  const typeHash = descriptorTypeHash(descriptor);
  let structHash: Hex;
  if (fold.nestedLeafCount === 0) {
    structHash = keccak256(concat([typeHash, ...words]));
  } else {
    const nestedTypeHash = fold.nestedTypeHash;
    const nestedWords = words.slice(fold.nestedLeafStart, fold.nestedLeafStart + fold.nestedLeafCount);
    const nestedHash = keccak256(concat([nestedTypeHash, ...nestedWords]));
    const top: Hex[] = [
      ...words.slice(0, fold.nestedLeafStart),
      nestedHash,
      ...words.slice(fold.nestedLeafStart + fold.nestedLeafCount),
    ];
    structHash = keccak256(concat([typeHash, ...top]));
  }
  const digest = keccak256(concat(['0x1901', descriptorDomainSeparator(descriptor), structHash]));

  return {
    ok: true,
    descriptorId: descriptor.descriptorId,
    typedData: { domain, types: buildViemTypes(descriptor), primaryType: descriptor.primaryType, message: buildMessage(descriptor, coercedByName) },
    fields: words,
    digest,
    spender,
    amountWei: amount.toString(),
    deadlineSec,
    humanReadable: decodeForHuman(descriptor, spender, amount, deadlineSec, input.ctx.nowSec, rule.token),
  };
}

/** The viem `types` map for a descriptor — primary (nested member referencing the sub-struct) +
 * the sub-struct entry when nested. Used for the display payload + the viem `hashTypedData` oracle. */
function buildViemTypes(descriptor: SigningDescriptor): Record<string, Eip712Field[]> {
  const types: Record<string, Eip712Field[]> = {
    [descriptor.primaryType]: descriptor.fields.map((f) => ({ ...f })),
  };
  if (descriptor.nested) types[descriptor.nested.structType] = descriptor.nested.subFields.map((f) => ({ ...f }));
  return types;
}

/** The EIP-712 message object — nesting the sub-struct's leaves under its member name when nested. */
function buildMessage(
  descriptor: SigningDescriptor,
  coercedByName: Record<string, string | bigint | boolean>,
): Record<string, unknown> {
  const message: Record<string, unknown> = {};
  for (const f of descriptor.fields) {
    if (descriptor.nested && f.name === descriptor.nested.memberName) {
      const sub: Record<string, unknown> = {};
      for (const s of descriptor.nested.subFields) sub[s.name] = coercedByName[s.name];
      message[f.name] = sub;
    } else {
      message[f.name] = coercedByName[f.name];
    }
  }
  return message;
}

/**
 * A human-readable decode of EXACTLY what would be signed (FP-c, 00 §9) — the only
 * thing ever surfaced to the owner for approval, never the raw digest/blob.
 */
export function decodeForHuman(
  descriptor: SigningDescriptor,
  spender: string,
  amount: bigint,
  deadlineSec: number,
  nowSec: number,
  token: string,
): string {
  const mins = Math.max(0, Math.round((deadlineSec - nowSec) / 60));
  return `Sign a ${descriptor.protocol}: authorize ${amount.toString()} (base units of ${short(token)}) to ${short(spender)}, expires in ~${mins} min.`;
}

function short(addr: string): string {
  const a = addr.toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/**
 * Resolve the single authority spender: pin it when exactly one is granted; accept
 * a proposed spender ONLY if it is ∈ the owner's granted set (never a novel one).
 * Ambiguity with no in-set proposal → unresolved (stand down).
 */
function resolveSpender(rule: SigningRule, proposed?: string): string | null {
  const set = rule.spenderSet.map((s) => s.toLowerCase());
  if (proposed) {
    const p = proposed.toLowerCase();
    return set.includes(p) ? p : null;
  }
  return set.length === 1 ? (set[0] ?? null) : null;
}

/**
 * The enumerated set of EIP-712 field names that denote the SELF/account party of a
 * permit — the party on whose behalf the account signs. Every one is pinned to the
 * account `self` (never a confused-deputy address from model text):
 *   - `owner`   — ERC-2612 permit holder;
 *   - `holder`  — DAI-style permit holder;
 *   - `account` — AAVE / generic account-permit party;
 *   - `from`    — transfer-authorization source;
 *   - `maker`   — order/intent maker (CoW, 0x, Hyperliquid).
 * A NEW descriptor whose self-party uses a name outside this list must extend it with
 * review (never inferred) — an unrecognized self-field falls through to the `pins`
 * path and stands the build down (`missing_pin`) rather than fabricate self.
 */
function isOwnerField(name: string): boolean {
  return name === 'owner' || name === 'holder' || name === 'account' || name === 'from' || name === 'maker';
}

/** Coerce a pinned value to its static field type, or null if it does not fit (fail-closed). */
function coerce(type: string, value: string | number | bigint | boolean): string | bigint | boolean | null {
  if (type === 'address') {
    const s = String(value).toLowerCase();
    return /^0x[0-9a-f]{40}$/.test(s) ? s : null;
  }
  if (type === 'bool') return typeof value === 'boolean' ? value : null;
  const bytesN = /^bytes([1-9]|[12][0-9]|3[0-2])$/.exec(type);
  if (bytesN) {
    const s = String(value).toLowerCase();
    // fail-closed: a bytesN pin MUST be exactly N bytes (`0x` + 2 hex chars each).
    // A wrong-length hex string would otherwise silently right-pad (or throw deep in
    // encodeAbiParameters) — latent today (no built-in uses bytesN), load-bearing for
    // FP-3 descriptors that do. Enforce the exact width here (bad_pin on mismatch).
    const n = Number(bytesN[1]);
    if (!/^0x[0-9a-f]+$/.test(s) || s.length !== 2 + 2 * n) return null;
    return s;
  }
  // uintN / intN
  try {
    const v = typeof value === 'bigint' ? value : BigInt(String(value));
    if (type.startsWith('uint') && v < 0n) return null;
    return v;
  } catch {
    return null;
  }
}
