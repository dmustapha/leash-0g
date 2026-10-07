import type {
  SigningClassification,
  SigningDescriptor,
  SigningGrantState,
  SigningTrigger,
  SigningWidenReason,
} from './types.js';

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
  const amount = parseAmount(intended.amountWei);
  if (amount === null) return { lane: 'forbidden', reason: 'malformed_intent' };
  if (!Number.isInteger(intended.deadlineSec) || intended.deadlineSec <= nowSec) {
    return { lane: 'forbidden', reason: 'malformed_intent' };
  }

  // Default-deny: no standing (or removed) rule ⇒ the owner must grant first. An
  // on-chain arm reverts `DescriptorNotRegistered`; off-chain that is an L3 widen.
  const rule = grant.rules.get(intended.descriptorId);
  if (!rule || !rule.active) return { lane: 'l3_widen', reasons: ['no_grant'] };

  // Outside-the-standing-grant checks — each would REVERT at `authorizeSigningIntent`;
  // the resolution is a timelocked owner widen (no signing one-shot exists).
  const widen: SigningWidenReason[] = [];
  const spenders = new Set(rule.spenderSet.map((s) => s.toLowerCase()));
  if (!spenders.has(intended.spender.toLowerCase())) widen.push('new_spender');
  const cap = parseAmount(rule.perIntentCap);
  if (cap === null || amount > cap) widen.push('over_cap');
  // deadline beyond the granted window (0 window ⇒ the descriptor is disabled).
  if (intended.deadlineSec > nowSec + rule.maxDeadlineWindow) widen.push('deadline_too_far');
  if (widen.length > 0) return { lane: 'l3_widen', reasons: dedupe(widen) };

  // In policy. A sensitive descriptor ALWAYS asks (00 §6c) — the owner consents to
  // each sign even inside the standing grant; it can never classify L1.
  const triggers: SigningTrigger[] = [];
  if (descriptor.sensitive) triggers.push('sensitive');
  if (triggers.length > 0) return { lane: 'l2', triggers: dedupe(triggers) };

  return { lane: 'l1', reason: 'in_policy' };
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/** Parse a base-units decimal amount; null if not a positive-or-zero integer string. */
function parseAmount(s: string): bigint | null {
  if (typeof s !== 'string' || !/^\d{1,40}$/.test(s)) return null;
  try {
    const v = BigInt(s);
    return v >= 0n ? v : null;
  } catch {
    return null;
  }
}
