/**
 * Governed-calldata grammar — off-chain types (Stage D).
 *
 * The ON-CHAIN `LeashAccountV4` wall is the sole enforcement guarantee; this
 * module is the OFF-CHAIN layer that only ever NARROWS (decode → legible intent,
 * classify novelty, recursive unwrap, preset sugar). Every type here MIRRORS the
 * on-chain `CallRule`/structured-decoder semantics so the off-chain classify can
 * never diverge from what the account will actually enforce (H-04).
 */

/** Server mirror of the on-chain `CallRule` (source of truth = the account). */
export interface CallRule {
  /** allowlisted target contract (owner-authored, lowercased 0x address). */
  target: string;
  /** 4-byte function selector, lowercased `0x`-prefixed. */
  selector: string;
  /** recipient pin: `self` = every recipient-type arg must == the account; `allowlist` = ∈ allowlist. */
  recipientMode: 'self' | 'allowlist';
  /** allowlisted spenders (for approve/increaseAllowance/setApprovalForAll-shaped selectors). */
  spenderSet: string[];
  /** base-units per-call cap on the chargeable amount (decoded amount, or msg.value). */
  perCallCap: string;
  /** base-units cumulative per-(target,selector) tumbling-window cap. */
  windowCapCall: string;
  /** optional ERC-1967 impl codehash pin (C-05); `0x0…0` = no pin. */
  codehash?: string;
}

/** A capability preset (D-9): off-chain bundle → a batch of grant proposals + the JIT deny-list. */
export interface CapabilityPreset {
  key: PresetKey;
  label: string;
  /** plain-language description for the normie-legible grant UX (`00 §2c`). */
  description: string;
  /** expands to `proposeCallRule` proposals (loosen-timelocked). */
  rules: CallRule[];
  /** per-token cumulative outflow budgets (the spine, D-3) the preset proposes. */
  budgets: { token: string; windowCap: string }[];
  /** always-JIT triggers layered on top of the standing envelope. */
  denyList: DenyTrigger[];
}

export type PresetKey =
  | 'defi_trader'
  | 'yield_manager'
  | 'treasury_topper'
  | 'dca'
  | 'rebalancer'
  | 'leverage_adv';

/** The global JIT deny-list categories (brief §6) — a match forces L2 even inside a grant. */
export type DenyTrigger =
  | 'new_spender'
  | 'unlimited_approval'
  | 'new_recipient'
  | 'bridge'
  | 'self_edit'
  | 'over_budget';

/** Authority arguments extracted by the strict-canonical decoder (mirrors the on-chain decode). */
export interface AuthorityArgs {
  /** true iff the selector is in the on-chain hard-coded structured set. */
  structured: boolean;
  /** the chargeable amount the on-chain wall debits (0 when nothing flows out on-chain). */
  amount: bigint;
  /** the token whose cumulative budget is debited: the target for structured ERC-20 selectors, `0x0…0` for native value. */
  spendToken: string;
  /** approve/increaseAllowance/setApprovalForAll spender/operator. */
  spender?: string;
  /** recipient-type args (`to`/`receiver`/`recipient`) that must pin to self or ∈ allowlist. */
  recipients: string[];
  /** transferFrom `from` — must == self (never a confused-deputy pull). */
  from?: string;
  /** setApprovalForAll bool. */
  approvedForAll?: boolean;
  /** true iff `approve(type(uint256).max)` — forbidden on-chain. */
  infiniteApproval?: boolean;
  /**
   * AQ-FND M-4: the DECODED far-chain destination of a multi-domain rail leg
   * (CCTP `destinationDomain`, CCIP `destinationChainSelector`). These rails serve
   * many destinations from ONE contract address, so the bridge-gate resolves the
   * destination chain from this decoded value (`rail-domains.ts`) instead of the
   * one-target→one-destination `bridgeDestinations` config map.
   */
  bridgeDestination?: { kind: 'cctp_domain' | 'ccip_selector'; value: string };
}

/** Result of decoding one intended call. Mirrors the on-chain revert taxonomy where it matters. */
export interface DecodedCall {
  target: string;
  value: bigint;
  data: string;
  selector: string;
  /** canonical signature when the selector is known to the grammar, else null. */
  signature: string | null;
  /** normie-legible one-liner for the approval card (never raw calldata). */
  humanReadable: string;
  args: AuthorityArgs;
  /**
   * A structural defect the on-chain wall would revert on (H-04 divergence class):
   * decode-length/canonicalness mismatch, banned infinite approval, blanket approval.
   * When set, the call is FORBIDDEN regardless of grant state (fail-closed).
   */
  reject?: 'DecodeMismatch' | 'InfiniteApprovalForbidden' | 'BlanketApprovalForbidden';
}

/** The on-chain envelope state the off-chain classify reads (a mirror; the account is authoritative). */
export interface GrantState {
  /** granted (target,selector) rules, keyed `${target}:${selector}` (both lowercased). */
  rules: Map<string, CallRule>;
  /** per-token cumulative budget windowCaps (base-units), keyed by lowercased token (`0x0…0` = native). */
  budgets: Map<string, string>;
  /** the account's recipient allowlist (lowercased addresses) — for `recipientMode:'allowlist'`. */
  allowlist: Set<string>;
  /**
   * SE-8: the chain's owner-configured bridge allowlist (`ChainConfig.bridgeAllowlist`,
   * lowercased) — CONSUMED by classify (carry #2, never a dormant field): a bridge
   * selector against a target outside this set is forbidden, and ANY selector against
   * a target inside it that lacks a structured bridge decoder is forbidden (BR-2
   * default-DENY). Absent/empty = no bridging is possible on this chain.
   */
  bridgeTargets?: Set<string>;
}

/** Classification of an intended call against the on-chain envelope (the three-lane model). */
export type Classification =
  | { lane: 'l1'; reason: 'in_envelope' }
  | { lane: 'l2'; novelty: Novelty[] }
  | { lane: 'forbidden'; reason: ForbiddenReason };

export type Novelty =
  | 'new_target'
  | 'new_selector'
  | 'over_cap'
  | 'over_budget'
  | 'new_spender'
  | 'new_recipient'
  | 'bridge'
  | 'self_edit';

export type ForbiddenReason =
  | 'decode_mismatch'
  | 'infinite_approval'
  | 'blanket_approval'
  | 'self_call'
  | 'recipient_not_self'
  | 'from_not_self'
  | 'unknown_batcher'
  | 'delegatecall'
  // SE-8 (BR-2): bridge lane refusals — no structured decoder / off-allowlist bridge.
  | 'bridge_undecodable'
  | 'bridge_not_allowlisted';
