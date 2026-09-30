import { toFunctionSelector } from 'viem';

/**
 * The canonical selector registry (grammar §3b). Maps each protocol selector →
 * its authority-arg ordinal positions + the decoder semantics. This MIRRORS the
 * on-chain `LeashAccountV4._checkStructuredArgs` for the STRUCTURED set (so the
 * off-chain decode can never diverge from enforcement, H-04), and extends it
 * with curated router/vault signatures the on-chain wall treats as
 * non-structured (charging msg.value) but which the off-chain gate decodes for
 * legibility + recipient-redirection narrowing (defense-in-depth, §4).
 */

/** How one static-position argument is used for authority checks. */
export type ArgRole = 'spender' | 'recipient' | 'from' | 'amount' | 'approvedBool' | 'ignore';

export interface SelectorSpec {
  signature: string;
  /** the ABI param types in order (static-position decode). */
  paramTypes: ('address' | 'uint256' | 'uint32' | 'bool')[];
  /** role of each positional arg (same length as paramTypes). */
  roles: ArgRole[];
  /**
   * true iff the on-chain wall hard-decodes this selector's args (the account's
   * structured set). Non-structured selectors are decoded off-chain only; on-chain
   * they charge msg.value against the native budget (v1 decision (a)).
   */
  structured: boolean;
  /** which positional arg (index) is the chargeable amount, or null. */
  amountIndex: number | null;
  /** the token whose cumulative budget the amount debits: 'target' | 'native'. */
  spendToken: 'target' | 'native';
  /** a short label for the human-readable card verb. */
  verb: string;
  /**
   * SE-8 bridge decoders: the signature ends in a dynamic `bytes extraData` the
   * wall FORCES EMPTY (canonical head offset + zero length — an arbitrary tail
   * would be an opaque payload surface). Adds exactly 2 words to the calldata.
   */
  trailingEmptyBytes?: true;
  /** the chargeable amount is `msg.value` (payable bridge leg), not an arg word. */
  valueIsAmount?: true;
  /** msg.value MUST be zero (nonpayable; value may never ride uncharged). */
  forbidValue?: true;
  /** SE-8: this selector is a structured BRIDGE-family decoder (BR-2). */
  bridge?: true;
}

/** Build a spec keyed by its computed 4-byte selector. */
function spec(s: Omit<SelectorSpec, 'signature'> & { signature: string }): [string, SelectorSpec] {
  return [toFunctionSelector(s.signature).toLowerCase(), s];
}

export const SELECTORS: ReadonlyMap<string, SelectorSpec> = new Map<string, SelectorSpec>([
  // ---- structured ERC-20 set (on-chain hard-decoded — must match the account exactly) ----
  spec({
    signature: 'function approve(address spender, uint256 amount)',
    paramTypes: ['address', 'uint256'],
    roles: ['spender', 'amount'],
    structured: true,
    amountIndex: 1,
    spendToken: 'target',
    verb: 'approve',
  }),
  spec({
    signature: 'function increaseAllowance(address spender, uint256 addedValue)',
    paramTypes: ['address', 'uint256'],
    roles: ['spender', 'amount'],
    structured: true,
    amountIndex: 1,
    spendToken: 'target',
    verb: 'increase allowance for',
  }),
  spec({
    signature: 'function transfer(address to, uint256 amount)',
    paramTypes: ['address', 'uint256'],
    roles: ['recipient', 'amount'],
    structured: true,
    amountIndex: 1,
    spendToken: 'target',
    verb: 'transfer',
  }),
  spec({
    signature: 'function transferFrom(address from, address to, uint256 amount)',
    paramTypes: ['address', 'address', 'uint256'],
    roles: ['from', 'recipient', 'amount'],
    structured: true,
    amountIndex: 2,
    spendToken: 'target',
    verb: 'transfer',
  }),
  spec({
    signature: 'function setApprovalForAll(address operator, bool approved)',
    paramTypes: ['address', 'bool'],
    roles: ['spender', 'approvedBool'],
    structured: true,
    amountIndex: null,
    spendToken: 'target',
    verb: 'set approval-for-all on',
  }),
  // ---- SE-8 structured OP-stack bridge family (on-chain hard-decoded, BR-2) ----
  spec({
    signature: 'function bridgeETHTo(address to, uint32 minGasLimit, bytes extraData)',
    paramTypes: ['address', 'uint32'],
    roles: ['recipient', 'ignore'],
    structured: true,
    amountIndex: null,
    spendToken: 'native',
    verb: 'bridge',
    trailingEmptyBytes: true,
    valueIsAmount: true,
    bridge: true,
  }),
  spec({
    signature:
      'function bridgeERC20To(address localToken, address remoteToken, address to, uint256 amount, uint32 minGasLimit, bytes extraData)',
    paramTypes: ['address', 'address', 'address', 'uint256', 'uint32'],
    roles: ['ignore', 'ignore', 'recipient', 'amount', 'ignore'],
    structured: true,
    amountIndex: 3,
    spendToken: 'target',
    verb: 'bridge',
    trailingEmptyBytes: true,
    forbidValue: true,
    bridge: true,
  }),
  // ---- curated router/vault set (off-chain legibility only; on-chain non-structured) ----
  // MockRouter.swap(tokenIn,tokenOut,amountIn,amountOutMin,recipient,deadline).
  spec({
    signature:
      'function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin, address recipient, uint256 deadline)',
    paramTypes: ['address', 'address', 'uint256', 'uint256', 'address', 'uint256'],
    roles: ['ignore', 'ignore', 'amount', 'ignore', 'recipient', 'ignore'],
    structured: false,
    amountIndex: 2,
    spendToken: 'native',
    verb: 'swap',
  }),
  // MockVault / ERC-4626 deposit(assets, receiver).
  spec({
    signature: 'function deposit(uint256 assets, address receiver)',
    paramTypes: ['uint256', 'address'],
    roles: ['amount', 'recipient'],
    structured: false,
    amountIndex: 0,
    spendToken: 'native',
    verb: 'deposit into',
  }),
]);

/**
 * Known call-wrapper selectors (C-03) — default-denied on-chain, recursively
 * unwrapped off-chain. ONLY self-targeting `bytes[]` batchers are permitted:
 * their leaves execute as calls to the wrapper itself (address(this)), so
 * `classifyInner` correctly re-checks every leaf against the SAME target. A
 * per-leaf-target batcher (Multicall3 `aggregate3((address,bytes)[])`) would
 * break that assumption — deliberately NOT a kind here, so adding one fails to
 * compile until per-leaf target extraction is wired (W1, code-review 2026-09-28).
 */
export const WRAPPER_SELECTORS: ReadonlyMap<string, { signature: string; kind: 'multicall_bytes' }> =
  new Map([
    [
      toFunctionSelector('function multicall(bytes[] data)').toLowerCase(),
      { signature: 'function multicall(bytes[] data)', kind: 'multicall_bytes' },
    ],
    // Uniswap V3 SwapRouter multicall(uint256 deadline, bytes[] data) — deadline-prefixed variant.
    [
      toFunctionSelector('function multicall(uint256 deadline, bytes[] data)').toLowerCase(),
      { signature: 'function multicall(uint256 deadline, bytes[] data)', kind: 'multicall_bytes' },
    ],
  ]);

/** Selectors that force JIT because they let an agent edit its own policy/authority (self_edit deny). */
export const SELF_EDIT_SELECTORS: ReadonlySet<string> = new Set(
  [
    'function proposeCallRule(address,bytes4,uint8,address[],uint128,uint128,bytes32)',
    'function applyCallRule()',
    'function authorizeOnce(bytes32,uint64)',
    'function setSessionKey(address)',
    'function setGuardian(address)',
    'function proposePolicy((uint128,uint128,uint32,uint64))',
    'function proposeAllowlist(address)',
    'function proposeSpendBudget(address,uint128)',
    // governance-style delegation (M-01)
    'function delegate(address)',
  ].map((s) => toFunctionSelector(s).toLowerCase()),
);

/**
 * SE-8 (BR-2): the ONLY bridge selectors a governed call may carry. A call to a
 * bridge-allowlisted target with ANY other selector is default-DENIED (a bridge
 * without a structured decoder is never governable); a bridge selector against a
 * target NOT in the chain's bridge allowlist is likewise refused.
 */
export const BRIDGE_SELECTORS: ReadonlySet<string> = new Set(
  [...SELECTORS.entries()].filter(([, s]) => s.bridge).map(([sel]) => sel),
);

export const SELECTOR_APPROVE = toFunctionSelector('function approve(address,uint256)').toLowerCase();
export const SELECTOR_SET_APPROVAL_FOR_ALL = toFunctionSelector('function setApprovalForAll(address,bool)').toLowerCase();
