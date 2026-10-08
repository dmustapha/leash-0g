import type {
  SigningClassification,
  SigningDescriptor,
  SigningGrantState,
  SigningWidenReason,
} from './types.js';
import { parseSigningAmount } from './amount.js';

/**
 * The intended signing the classifier routes — the MINIMAL model intent: which
 * reviewed descriptor, which spender it would name, the chargeable amount, and the
 * server-derived deadline. These are the SAME three authority values the on-chain
 * `authorizeSigningIntent` policy-checks; classify reads ONLY them + the owner's
 * grant-state, never any other model text (00 §6c — reasoning never trusted for
 * authority), exactly as `governed-call/classify` reads the decoded call.
 */
export interface IntendedSigning {
  descriptorId: number;
  /** the spender the permit would authorize (lowercased 0x), resolved from the grant. */
  spender: string;
  /** the chargeable amount, base-units decimal string. */
  amountWei: string;
  /** the absolute unix-seconds deadline the server derived (now + window). */
  deadlineSec: number;
}

/**
 * Classify an intended signing against the owner's signing grant-state (FP-2, the
 * three-lane model — mirror of `governed-call/classify.ts` + `tool-use/
 * tool-classify.ts`). PURE: reads only the passed descriptor (registry) + the
 * grant-state mirror. Fail-closed by construction:
 *   - unknown descriptor      → forbidden (default-deny, NEVER inferred — 00 §9);
 *   - malformed amount/deadline→ forbidden (structural);
 *   - no/removed grant         → L3 widen (owner must grant — timelocked);
 *   - new spender / over cap / deadline too far → L3 widen (on-chain would REVERT;
 *     a signing arm has no one-shot bypass, so the ONLY resolution is a timelocked
 *     grant widen — this is why signing has an L3 lane the calling path lacks);
 *   - sensitive descriptor     → L2 ALWAYS (00 §6c — owner consents per-sign);
 *   - otherwise                → L1 (build + arm silently).
 *
 * `nowSec` is the reference time for the deadline-window check (injected for
 * determinism; defaults to wall-clock at call time at the edges).
 */
export function classifySigning(
  intended: IntendedSigning,
  descriptor: SigningDescriptor | undefined,
  grant: SigningGrantState,
  nowSec: number,
): SigningClassification {
  // Unknown descriptor — the registry has no reviewed entry. REFUSED, never
  // inferred: an un-described typed-data is exactly the 00 §9 drain shape.
  if (!descriptor) return { lane: 'forbidden', reason: 'unknown_descriptor' };

  // Structural validity of the money/time the model proposed.
  const amount = parseSigningAmount(intended.amountWei);
  if (amount === null) return { lane: 'forbidden', reason: 'malformed_intent' };
  if (!Number.isInteger(intended.deadlineSec) || intended.deadlineSec <= nowSec) {
    return { lane: 'forbidden', reason: 'malformed_intent' };
  }

  // Sensitive = the L2 floor, evaluated BEFORE any grant/widen check (00 §6c). A
  // sensitive descriptor ALWAYS asks the owner per-sign: the consent IS the authority
  // for that one signature, so cap/deadline/spender/grant-state can never downgrade it
  // to L1 or upgrade it to L3. (Only the structural forbidden guards above outrank it —
  // an un-described or malformed intent is refused outright.) This is what the HTTP
  // `always_allow` branch relies on: after the owner consents once, the NEXT sign of a
  // sensitive descriptor must re-classify L2, not L3 — the defect the FP-2 re-gate caught.
  if (descriptor.sensitive) return { lane: 'l2', triggers: ['sensitive'] };

  // Default-deny: no standing (or removed) rule ⇒ the owner must grant first. An
  // on-chain arm reverts `DescriptorNotRegistered`; off-chain that is an L3 widen.
  const rule = grant.rules.get(intended.descriptorId);
  if (!rule || !rule.active) return { lane: 'l3_widen', reasons: ['no_grant'] };

  // Outside-the-standing-grant checks — each would REVERT at `authorizeSigningIntent`;
  // the resolution is a timelocked owner widen (no signing one-shot exists).
  const widen: SigningWidenReason[] = [];
  const isOrder = descriptor.kind === 'order';
  // FP-4 Slice-4 (§5.4, I-1): a CoW order has no spender (empty spender set is not a widen) — skip the
  // new-spender check for order; every other kind keeps it.
  if (!isOrder) {
    const spenders = new Set(rule.spenderSet.map((s) => s.toLowerCase()));
    if (!spenders.has(intended.spender.toLowerCase())) widen.push('new_spender');
  }
  const cap = parseSigningAmount(rule.perIntentCap);
  // FP-4 Slice-4 (§5.4, I-2): order's chargeable outflow is `sellAmount + feeAmount` (the wall debits the
  // sum). `feeAmount` is a reviewed pinned constant (0 today); adding it keeps parity if a future reviewed
  // max fee is pinned. Non-order: chargeable == amount.
  const fee = isOrder ? orderFeeAmount(descriptor) : 0n;
  if (cap === null || amount + fee > cap) widen.push('over_cap');
  // deadline beyond the granted window (0 window ⇒ the descriptor is disabled).
  if (intended.deadlineSec > nowSec + rule.maxDeadlineWindow) widen.push('deadline_too_far');
  if (widen.length > 0) return { lane: 'l3_widen', reasons: dedupe(widen) };

  return { lane: 'l1', reason: 'in_policy' };
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/** The reviewed pinned `feeAmount` of an order descriptor (0 today), as base-units bigint. Fail-closed to 0
 *  if absent/unparseable — the on-chain wall still reads `fields[7]` into the debit regardless. */
function orderFeeAmount(descriptor: SigningDescriptor): bigint {
  const pin = descriptor.constantPins?.['feeAmount'];
  if (pin === undefined) return 0n;
  try {
    return BigInt(typeof pin === 'bigint' ? pin : String(pin));
  } catch {
    return 0n;
  }
}
