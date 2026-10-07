/**
 * Governed signing grammar — off-chain types (Stage F′, FP-2).
 *
 * This module is the OFF-CHAIN engine that drives the `LeashAccountV5` signing
 * spine (FP-1). Where `governed-call/` narrows the on-chain money surface and
 * `tool-use/` governs the off-chain tool surface, `signing/` governs the FIRST
 * on-chain-AUTHORITY off-chain artifact: an EIP-712 typed-data message a bound
 * agent would sign so a permit/intent protocol (ERC-2612, CoW, Hyperliquid, flat
 * Permit2) can act. The on-chain `authorizeSigningIntent`/`isValidSignature` wall
 * is the sole enforcement guarantee; every type here only ever NARROWS and is
 * fail-closed by construction:
 *   - descriptor-bound only: a typed-data with no REVIEWED descriptor is REFUSED,
 *     never inferred (00 §9 — an un-readable signature is the Grok/Bankr drain);
 *   - never-guess-money: spender/amount/deadline are PINNED from server grant
 *     state, never model text (the Stage-D call-builder discipline on typed-data);
 *   - signing ≤ calling: a built intent debits the SAME per-token budget the
 *     `executeCall` wall enforces (the on-chain spine, not this layer).
 *
 * Every field here MIRRORS the on-chain `SigningIntentPolicy` so the off-chain
 * engine can never diverge from what `LeashAccountV5` will actually enforce.
 */

import type { Hex } from 'viem';

/**
 * The EIP-712 domain of a descriptor. N-01 (FP-1 security-auditor, D-FP1-3):
 * `chainId` + `verifyingContract` MUST be bound — a domain missing either is a
 * cross-chain / cross-contract replay surface and is rejected at descriptor-review
 * time (`assertDescriptor`). `salt` is optional; `name`/`version` are display +
 * domainSeparator inputs.
 */
export interface Eip712Domain {
  name?: string;
  version?: string;
  /** BOUND (N-01) — the chain the signature is valid on; nonzero. */
  chainId: number;
  /** BOUND (N-01) — the contract that will verify the signature; nonzero 0x address. */
  verifyingContract: string;
  salt?: Hex;
}

/** One ordered field of the primary struct. N-02: `type` MUST be a static 32-byte word. */
export interface Eip712Field {
  name: string;
  /** a STATIC ABI type only (address/bool/bytesN≤32/uintN/intN) — N-02 rejects dynamic/nested. */
  type: string;
}

/**
 * A reviewed signing descriptor — the authority surface the engine trusts, the
 * off-chain mirror of one on-chain `signingIntentPolicy[descriptorId]` registry
 * row. Owner/LEASH-authored; NEVER derived from model text or a protocol response.
 * A descriptor the registry does not know is `unknown_descriptor` → refused
 * (default-deny, the 00 §9 floor — the engine never infers an un-described type).
 */
export interface SigningDescriptor {
  /** the on-chain registry key (`signingIntentPolicy[descriptorId]`). */
  descriptorId: number;
  /** stable human id, e.g. `erc2612.permit`. */
  key: string;
  /** display label for the policy editor / JIT card. */
  label: string;
  /** protocol family (display), e.g. `ERC-2612 Permit`. */
  protocol: string;
  /** the EIP-712 domain (chainId + verifyingContract bound — N-01). */
  domain: Eip712Domain;
  /** the EIP-712 primaryType name. */
  primaryType: string;
  /** ordered fields — index order MUST equal the on-chain numFields/indices. */
  fields: Eip712Field[];
  /** which field NAMES carry the three authority roles (mirror of the on-chain indices). */
  roles: { spender: string; amount: string; deadline: string };
  /**
   * sensitive = ALWAYS requires owner approval (L2) regardless of grant-state or
   * what the model decided (00 §6c). A sensitive descriptor can never classify L1.
   */
  sensitive: boolean;
}

/** The owner's standing grant for one descriptor (server mirror of the on-chain policy row). */
export interface SigningRule {
  descriptorId: number;
  /** granted spenders the agent may name (lowercased); a spender outside this set is L3-widen. */
  spenderSet: string[];
  /** base-units per-intent cap on the chargeable amount (on-chain `perIntentCap`). */
  perIntentCap: string;
  /** max seconds into the future a deadline may sit (on-chain `maxDeadlineWindow`); 0 disables. */
  maxDeadlineWindow: number;
  /** the per-token budget the amount is bound to (the SAME budget `executeCall` debits). */
  token: string;
  /** false ⇒ explicitly removed (default-deny); absent rule ⇒ also default-deny. */
  active: boolean;
}

/**
 * The signing grant-state the classifier/builder read (owner-authored mirror).
 * Authority is the on-chain wall — these rows only mirror what the owner granted.
 */
export interface SigningGrantState {
  /** granted rules keyed by `descriptorId`. */
  rules: Map<number, SigningRule>;
  /**
   * the current on-chain `signingEpoch` (FP-CARRY-5). Every signing-relevant
   * tighten/remove/revoke bumps it; an armed intent snapshotting an older epoch is
   * INVALID in `isValidSignature`. The read-model reconcile marks such arms stale.
   */
  signingEpoch: number;
}

/** Classification of an intended signing against the owner's grant (the three-lane model + the floor). */
export type SigningClassification =
  /** fully in policy — the agent may build + arm silently. */
  | { lane: 'l1'; reason: 'in_policy' }
  /** a standing grant exists but the sign needs owner consent (sensitive, 00 §6c). */
  | { lane: 'l2'; triggers: SigningTrigger[] }
  /**
   * a KNOWN descriptor but outside the current caps/spenders/deadline — on-chain
   * the arm would REVERT. The resolution is an owner grant-WIDEN (a timelocked
   * loosening via `proposeSigningGrant`); surfaced so the owner can widen or refuse.
   */
  | { lane: 'l3_widen'; reasons: SigningWidenReason[] }
  /** structurally refused — the registry has no descriptor (never inferred; 00 §9 floor). */
  | { lane: 'forbidden'; reason: SigningForbiddenReason };

/** L2 (JIT-ask) triggers — within the grant but owner consent is required. */
export type SigningTrigger =
  /** the descriptor is sensitive — always ask (00 §6c). */
  | 'sensitive';

/** L3 reasons — outside the standing grant → a timelocked widen is required. */
export type SigningWidenReason =
  /** no standing (or removed) rule for this descriptor. */
  | 'no_grant'
  /** the named spender is outside the granted spender set. */
  | 'new_spender'
  /** the amount exceeds the per-intent cap. */
  | 'over_cap'
  /** the deadline sits beyond the granted deadline window. */
  | 'deadline_too_far';

/** Forbidden reasons — the default-deny floor, never surfaced as L1/L2/L3. */
export type SigningForbiddenReason =
  /** the registry has no descriptor for this id (never inferred). */
  | 'unknown_descriptor'
  /** the proposed amount/deadline is structurally invalid (non-positive deadline, bad amount). */
  | 'malformed_intent';
