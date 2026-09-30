// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title LeashAccountV4 — self-enforcing constrained account with GOVERNED CALLDATA.
/// @notice The FIRST contract change since Phase 4 (Stage D). It adds a THIRD
///         governed execution path — `executeCall(target, value, data)` — on top of
///         the UNCHANGED native `execute` (still `CalldataForbidden`) and settlement
///         `executeTokenTransfer`. Legacy v2/v3 accounts are frozen on their own
///         bytecode and are unaffected (F9 mixed-support); this is a NEW version the
///         factory deploys going forward.
///
///         DEFAULT-DENY stays (`00 §6c`, `07 S28`): the agent's session key can call
///         NOTHING except an owner-granted (target, selector, arg-rule, cap). Power is
///         broad GRANTING (presets/rules), never a default-allow flip. The on-chain
///         wall is the guarantee; the off-chain gateway only ever NARROWS it.
///
///         The wall enforces, in code, in order: session-key · not-revoked ·
///         not-expired · no self-call · no delegatecall (structural — `executeCall`
///         uses only `.call`; asserted by the no-delegatecall bytecode test) ·
///         target ∈ target-allowlist · selector ∈ that target's rule set · optional
///         codehash pin (C-05) · hard-coded structured-selector arg decode
///         (approve/transfer/transferFrom/setApprovalForAll/increaseAllowance:
///         recipient==self|∈allowlist · spender∈set · ban approve(max) · ban
///         setApprovalForAll(true) · strict canonical decode → `DecodeMismatch`) ·
///         per-call cap · the MULTI-LEG cumulative per-token outflow budget (the
///         spine — approve/transfer/transferFrom debit ONE shared per-token budget so
///         N sub-cap legs cannot aggregate-drain, `STAGE-D-RESEARCH-BRIEF §7`) ·
///         per-(target,selector) cumulative window cap · CEI + `nonReentrant`.
///
///         JIT (Lane 2): `authorizeOnce(callHash, expiry)` records a single-use,
///         owner-reviewed EXACT-call authorization that bypasses the standing
///         envelope ONCE (consumed on first use) — never a standing widen.
///
///         Grant surface (Lane 3): `proposeCallRule`/`applyCallRule` (add/loosen —
///         TIMELOCKED), `tightenCallRule`/`removeCallTarget`/`removeCallSelector`
///         (tighten/remove — INSTANT), and per-token budget propose/apply/tighten,
///         all mirroring the existing asymmetric timelock. NO ERC-1271 (C-02 closed
///         by construction — the account never validates a signature, so a session-key
///         permit over contract-held funds is invalid).
/// @dev    Windows are FIXED (tumbling) with lazy rollover — worst-case burst across
///         a boundary is <=2x cap (same M-02 acceptance as v3). Timelock queues are
///         single-pending slots; `revoke()` and every tighten clear ALL pending slots.
contract LeashAccountV4 is ReentrancyGuard {
    // ---------- v3 substrate (verbatim; legacy behavior unchanged) ----------
    struct Policy {
        uint128 perTransferCap;
        uint128 windowCap;
        uint32 windowSeconds;
        uint64 expiresAt;
    }

    struct TokenPolicy {
        uint128 perTransferCapToken;
        uint128 windowCapToken;
    }

    // ---------- Stage D — governed-calldata types ----------

    /// @notice An owner-granted rule for one (target, selector). `spenderSet` lives in
    ///         `callRuleSpender` (mappings can't nest in a struct). `recipientMode`:
    ///         0 = every recipient-type arg must == self; 1 = recipient may be any
    ///         address in the shared `allowlist`.
    struct CallRule {
        bool allowed;
        uint8 recipientMode;
        uint128 perCallCap; // per-call cap on the chargeable amount (decoded amount, or msg.value)
        uint128 windowCapCall; // cumulative per-(target,selector) window cap
        uint128 spentInWindowCall;
        uint64 windowStartCall;
    }

    /// @notice The multi-leg cumulative outflow budget for ONE token (the spine).
    ///         key = token address (== target for the structured ERC-20 selectors);
    ///         `address(0)` = native value moved via `executeCall`. Window duration is
    ///         the shared `policy.windowSeconds`.
    struct SpendBudget {
        bool set;
        uint128 windowCap;
        uint128 spent;
        uint64 windowStart;
    }

    // ---------- errors ----------
    error NotOwner();
    error NotGuardianOrOwner();
    error NotSessionKey();
    error AccountRevoked();
    error AccountNotRevoked();
    error SessionExpired();
    error NotAllowlisted(address to);
    error ZeroAddress();
    error CalldataForbidden();
    error OverPerTransferCap(uint256 value, uint128 cap);
    error OverWindowCap(uint256 attempted, uint128 cap);
    error CallFailed();
    error NothingPending();
    error TimelockNotElapsed(uint64 eta);
    error NotLoosening();
    error NotTightening();
    error InvalidPolicy();
    error NoSettlementToken();
    error TokenNotAllowlisted(address token);
    error OverPerTransferCapToken(uint256 amount, uint128 cap);
    error OverWindowCapToken(uint256 attempted, uint128 cap);
    error TokenTransferFailed();
    // Stage D — governed calldata
    error TargetNotAllowlisted(address target);
    error SelectorNotAllowlisted(bytes4 selector);
    error SelfCallForbidden();
    error InfiniteApprovalForbidden();
    error BlanketApprovalForbidden();
    error RecipientNotSelf(address recipient);
    error SpenderNotAllowlisted(address spender);
    error OverPerCallCap(uint256 amount, uint128 cap);
    error OverCumulativeSpend(uint256 attempted, uint128 cap);
    error OverCallWindowCap(uint256 attempted, uint128 cap);
    error BudgetNotSet(address token);
    error DecodeMismatch();
    error CodehashMismatch();
    error OneShotExpired();
    error EmptyCodeTarget(address target);

    // ---------- events ----------
    event Executed(address indexed to, uint256 value, uint128 spentInWindow);
    event TokenExecuted(address indexed token, address indexed to, uint256 amount, uint128 spentInWindowToken);
    event CallExecuted(address indexed target, bytes4 indexed selector, uint256 chargeable, bool oneShot);
    event TokenPolicyChanged(TokenPolicy p);
    event TokenPolicyProposed(TokenPolicy p, uint64 eta);
    event Revoked(address indexed by);
    event Rearmed(address indexed by);
    event PolicyChanged(Policy p);
    event PolicyProposed(Policy p, uint64 eta);
    event AllowlistProposed(address indexed to, uint64 eta);
    event AllowlistAdded(address indexed to);
    event AllowlistRemoved(address indexed to);
    event WithdrawProposed(address indexed to, uint256 amount, uint64 eta);
    event WithdrawExecuted(address indexed to, uint256 amount);
    event SessionKeyChanged(address indexed oldKey, address indexed newKey);
    event GuardianChanged(address indexed oldGuardian, address indexed newGuardian);
    event Deposited(address indexed from, uint256 amount);
    event CallRuleProposed(address indexed target, bytes4 indexed selector, uint64 eta);
    event CallRuleChanged(address indexed target, bytes4 indexed selector, uint128 perCallCap, uint128 windowCapCall);
    event CallRuleRemoved(address indexed target, bytes4 indexed selector);
    event CallTargetRemoved(address indexed target);
    event SpendBudgetProposed(address indexed token, uint128 windowCap, uint64 eta);
    event SpendBudgetChanged(address indexed token, uint128 windowCap);
    event OneShotAuthorized(bytes32 indexed callHash, uint64 expiry);
    event OneShotConsumed(bytes32 indexed callHash);

    // ---------- v3 state (verbatim) ----------
    address public immutable owner;
    address public guardian;
    address public sessionKey;
    bool public revoked;

    Policy public policy;
    uint128 public spentInWindow;
    uint64 public windowStart;

    address public immutable settlementToken;
    TokenPolicy public tokenPolicy;
    uint128 public spentInWindowToken;
    uint64 public windowStartToken;

    mapping(address => bool) public allowlist;

    uint64 public immutable timelockDelay;

    Policy public pendingPolicy;
    uint64 public pendingPolicyEta;
    address public pendingAllowlistAddr;
    uint64 public pendingAllowlistEta;
    address public pendingWithdrawTo;
    uint256 public pendingWithdrawAmount;
    uint64 public pendingWithdrawEta;
    TokenPolicy public pendingTokenPolicy;
    uint64 public pendingTokenPolicyEta;

    // ---------- Stage D state ----------
    // structured ERC-20 selectors (canonical signatures)
    bytes4 internal constant SEL_APPROVE = 0x095ea7b3; // approve(address,uint256)
    bytes4 internal constant SEL_INCREASE_ALLOWANCE = 0x39509351; // increaseAllowance(address,uint256)
    bytes4 internal constant SEL_TRANSFER = 0xa9059cbb; // transfer(address,uint256)
    bytes4 internal constant SEL_TRANSFER_FROM = 0x23b872dd; // transferFrom(address,address,uint256)
    bytes4 internal constant SEL_SET_APPROVAL_FOR_ALL = 0xa22cb465; // setApprovalForAll(address,bool)
    bytes4 internal constant SEL_DEPOSIT = 0x6e553f65; // deposit(uint256,address) — ERC-4626 curated-vault
    // Stage E (SE-8) — OP-stack bridge family (BR-2: a bridge selector without a
    // structured decoder is default-DENIED by the off-chain gate; these two are the
    // only bridge selectors the wall understands).
    bytes4 internal constant SEL_BRIDGE_ETH_TO = 0xe11013dd; // bridgeETHTo(address,uint32,bytes)
    bytes4 internal constant SEL_BRIDGE_ERC20_TO = 0x540abf73; // bridgeERC20To(address,address,address,uint256,uint32,bytes)

    mapping(address => bool) public callTargetAllowlist;
    mapping(bytes32 => CallRule) public callRules; // key = keccak256(target, selector)
    mapping(bytes32 => mapping(address => bool)) public callRuleSpender; // ruleKey => spender => allowed
    mapping(address => bytes32) public callTargetCodehash; // target => pinned codehash (0 = no pin)
    mapping(address => SpendBudget) public spendBudget; // token (address(0)=native) => cumulative outflow budget
    mapping(bytes32 => uint64) public oneShotAuthEta; // callHash => expiry (0 = none)

    // single-pending timelock slots for governed-calldata grants
    struct PendingCallRule {
        address target;
        bytes4 selector;
        uint8 recipientMode;
        uint128 perCallCap;
        uint128 windowCapCall;
        bytes32 codehash;
        uint64 eta; // 0 = none
    }

    PendingCallRule public pendingCallRule;
    address[] internal pendingCallRuleSpenders;

    address public pendingBudgetToken;
    uint128 public pendingBudgetWindowCap;
    uint64 public pendingBudgetEta; // 0 = none (the pending sentinel)

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        address owner_,
        address guardian_,
        address sessionKey_,
        Policy memory initialPolicy,
        address[] memory initialAllowlist,
        uint64 timelockDelay_,
        address settlementToken_,
        TokenPolicy memory initialTokenPolicy
    ) {
        if (owner_ == address(0) || sessionKey_ == address(0)) revert ZeroAddress();
        if (initialPolicy.windowSeconds == 0) revert InvalidPolicy();
        owner = owner_;
        guardian = guardian_;
        sessionKey = sessionKey_;
        policy = initialPolicy;
        windowStart = uint64(block.timestamp);
        timelockDelay = timelockDelay_;
        settlementToken = settlementToken_;
        if (settlementToken_ != address(0)) {
            tokenPolicy = initialTokenPolicy;
            windowStartToken = uint64(block.timestamp);
        }
        for (uint256 i = 0; i < initialAllowlist.length; i++) {
            if (initialAllowlist[i] == address(0)) revert ZeroAddress();
            allowlist[initialAllowlist[i]] = true;
            emit AllowlistAdded(initialAllowlist[i]);
        }
    }

    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    // ================= v3 spend paths (VERBATIM — unchanged) =================

    function execute(address to, uint256 value, bytes calldata data) external nonReentrant {
        if (msg.sender != sessionKey) revert NotSessionKey();
        if (revoked) revert AccountRevoked();
        Policy memory p = policy;
        if (block.timestamp > p.expiresAt) revert SessionExpired();
        if (to == address(0)) revert ZeroAddress();
        if (!allowlist[to]) revert NotAllowlisted(to);
        if (data.length != 0) revert CalldataForbidden();
        if (value > p.perTransferCap) revert OverPerTransferCap(value, p.perTransferCap);

        uint64 start = windowStart;
        if (block.timestamp >= uint256(start) + p.windowSeconds) {
            windowStart = uint64(block.timestamp);
            spentInWindow = 0;
        }
        uint256 attempted = uint256(spentInWindow) + value;
        if (attempted > p.windowCap) revert OverWindowCap(attempted, p.windowCap);

        spentInWindow = uint128(attempted);
        emit Executed(to, value, uint128(attempted));

        (bool ok,) = to.call{value: value}("");
        if (!ok) revert CallFailed();
    }

    function executeTokenTransfer(address token, address to, uint256 amount) external nonReentrant {
        if (msg.sender != sessionKey) revert NotSessionKey();
        if (revoked) revert AccountRevoked();
        Policy memory p = policy;
        if (block.timestamp > p.expiresAt) revert SessionExpired();
        if (to == address(0)) revert ZeroAddress();
        if (settlementToken == address(0)) revert NoSettlementToken();
        if (token != settlementToken) revert TokenNotAllowlisted(token);
        if (!allowlist[to]) revert NotAllowlisted(to);
        TokenPolicy memory tp = tokenPolicy;
        if (amount > tp.perTransferCapToken) revert OverPerTransferCapToken(amount, tp.perTransferCapToken);

        uint64 start = windowStartToken;
        if (block.timestamp >= uint256(start) + p.windowSeconds) {
            windowStartToken = uint64(block.timestamp);
            spentInWindowToken = 0;
        }
        uint256 attempted = uint256(spentInWindowToken) + amount;
        if (attempted > tp.windowCapToken) revert OverWindowCapToken(attempted, tp.windowCapToken);

        spentInWindowToken = uint128(attempted);
        emit TokenExecuted(token, to, amount, uint128(attempted));

        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TokenTransferFailed();
    }

    // ================= Stage D — governed calldata =================

    /// @notice The THIRD leashed path: call an allowlisted (target, selector) with
    ///         owner-granted arg constraints + cumulative caps. Uses ONLY `.call`
    ///         (never `delegatecall`) — arbitrary-code execution against the account's
    ///         own storage is impossible by construction.
    function executeCall(address target, uint256 value, bytes calldata data) external nonReentrant {
        if (msg.sender != sessionKey) revert NotSessionKey();
        if (revoked) revert AccountRevoked();
        Policy memory p = policy;
        if (block.timestamp > p.expiresAt) revert SessionExpired();
        if (target == address(this)) revert SelfCallForbidden();
        if (target == address(0)) revert ZeroAddress();
        if (data.length < 4) revert DecodeMismatch();
        if (target.code.length == 0) revert EmptyCodeTarget(target);

        bytes4 selector = bytes4(data[0:4]);
        bytes32 callHash = keccak256(abi.encode(target, selector, data, value));

        // JIT Lane-2: an owner-reviewed EXACT-call one-shot bypasses the standing
        // envelope ONCE. The owner signed this exact callHash, so full arg authority
        // rests with the owner; only the structural guards above apply. Consumed here.
        uint64 osEta = oneShotAuthEta[callHash];
        if (osEta != 0) {
            if (block.timestamp > osEta) revert OneShotExpired();
            delete oneShotAuthEta[callHash];
            emit OneShotConsumed(callHash);
            emit CallExecuted(target, selector, value, true);
            // A one-shot bypasses the standing ENVELOPE (arg authority — the owner
            // reviewed the exact bytes) but NOT the structural hardening: still
            // bound returndata (M-02) + SafeERC20 bool-check on a bool-returning
            // ERC-20 selector (H-05). It is deliberately OUTSIDE the cumulative
            // per-token budget + window caps (M-01, stated invariant): a one-shot
            // amount is ADDITIVE to the standing budget, since it is an explicit
            // owner-signed exact call, not an in-envelope agent action.
            (bool okOnce, bool emptyOnce, bytes32 retOnce) = _boundedCall(target, value, data);
            if (!okOnce) revert CallFailed();
            if (_isBoolReturningSelector(selector) && !emptyOnce && retOnce != bytes32(uint256(1))) {
                revert TokenTransferFailed();
            }
            return;
        }

        // Standing envelope (Lane 1): target + selector must be granted.
        if (!callTargetAllowlist[target]) revert TargetNotAllowlisted(target);
        // C-05: optional codehash pin defeats proxy-upgrade / metamorphic swaps.
        bytes32 pin = callTargetCodehash[target];
        if (pin != bytes32(0) && target.codehash != pin) revert CodehashMismatch();
        _enforceAndExecute(target, selector, value, data, p.windowSeconds);
    }

    /// @dev The standing-path accounting + bounded external call, in its own frame
    ///      (keeps `executeCall` under the stack limit without viaIR).
    function _enforceAndExecute(
        address target,
        bytes4 selector,
        uint256 value,
        bytes calldata data,
        uint32 windowSeconds
    ) internal {
        bytes32 ruleKey = keccak256(abi.encodePacked(target, selector));
        CallRule memory rule = callRules[ruleKey];
        if (!rule.allowed) revert SelectorNotAllowlisted(selector);

        // Structured-selector arg decode (D-2) → chargeable amount + token + bool-check.
        (uint256 chargeable, address spendToken, bool checkBoolReturn) =
            _checkStructuredArgs(target, selector, value, data, ruleKey, rule);

        // Per-call cap (D-2/D-4).
        if (chargeable > rule.perCallCap) revert OverPerCallCap(chargeable, rule.perCallCap);

        // Multi-leg cumulative per-token outflow budget (D-3, the spine) — debited
        // BEFORE the external call (CEI). Only when something actually flows out.
        if (chargeable > 0) {
            _debitSpendBudget(spendToken, chargeable, windowSeconds);
        }
        // Per-(target,selector) cumulative window cap (D-1).
        _debitCallWindow(ruleKey, chargeable, windowSeconds);

        emit CallExecuted(target, selector, chargeable, false);

        // M-02: bound returndata copy to 32 bytes (defeats a return-bomb griefing the
        // agent's gas) while still capturing the bool for the SafeERC20 check (H-05).
        (bool ok, bool empty, bytes32 retWord) = _boundedCall(target, value, data);
        if (!ok) revert CallFailed();
        // H-05: a structured ERC-20 bool-returning selector must return true (or
        // nothing). Empty returndata (non-standard token, e.g. early USDT) = success.
        if (checkBoolReturn && !empty && retWord != bytes32(uint256(1))) {
            revert TokenTransferFailed();
        }
    }

    /// @dev A `.call` that copies at most 32 bytes of returndata (M-02 return-bomb
    ///      bound) and reports whether the callee returned anything (for the H-05
    ///      SafeERC20 check). Never `delegatecall`.
    function _boundedCall(address target, uint256 value, bytes calldata data)
        internal
        returns (bool ok, bool empty, bytes32 retWord)
    {
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            calldatacopy(ptr, data.offset, data.length)
            ok := call(gas(), target, value, ptr, data.length, 0x00, 0x20)
            let rds := returndatasize()
            empty := iszero(rds)
            if iszero(empty) { retWord := mload(0x00) }
        }
    }

    /// @dev Hard-coded structured-selector decoders with STRICT CANONICAL decode
    ///      (H-04): exact calldata length, zero upper bits on address/bool words.
    ///      A non-canonical encoding reverts `DecodeMismatch` so the on-chain parse
    ///      can never diverge from what the target executes. Returns (chargeable,
    ///      spendToken) for the cumulative budget; a non-structured allowlisted
    ///      selector charges `msg.value` against the native budget and leaves rich
    ///      arg legibility to the off-chain gate (v1 decision (a)).
    function _checkStructuredArgs(
        address target,
        bytes4 selector,
        uint256 value,
        bytes calldata data,
        bytes32 ruleKey,
        CallRule memory rule
    ) internal view returns (uint256 chargeable, address spendToken, bool checkBoolReturn) {
        if (selector == SEL_APPROVE || selector == SEL_INCREASE_ALLOWANCE) {
            if (data.length != 4 + 64) revert DecodeMismatch();
            address spender = _decodeAddress(data, 4);
            uint256 amount = _decodeUint(data, 36);
            if (selector == SEL_APPROVE && amount == type(uint256).max) revert InfiniteApprovalForbidden();
            if (!callRuleSpender[ruleKey][spender]) revert SpenderNotAllowlisted(spender);
            return (amount, target, true);
        }
        if (selector == SEL_TRANSFER) {
            if (data.length != 4 + 64) revert DecodeMismatch();
            address to = _decodeAddress(data, 4);
            uint256 amount = _decodeUint(data, 36);
            _checkRecipient(to, rule.recipientMode);
            return (amount, target, true);
        }
        if (selector == SEL_TRANSFER_FROM) {
            if (data.length != 4 + 96) revert DecodeMismatch();
            address from = _decodeAddress(data, 4);
            address to = _decodeAddress(data, 36);
            uint256 amount = _decodeUint(data, 68);
            // spend only OUR OWN funds — never a confused-deputy transferFrom(victim,...)
            if (from != address(this)) revert RecipientNotSelf(from);
            _checkRecipient(to, rule.recipientMode);
            return (amount, target, true);
        }
        if (selector == SEL_SET_APPROVAL_FOR_ALL) {
            if (data.length != 4 + 64) revert DecodeMismatch();
            address operator = _decodeAddress(data, 4);
            uint256 approvedRaw = _decodeUint(data, 36);
            if (approvedRaw > 1) revert DecodeMismatch(); // bool canonical: 0 or 1
            if (approvedRaw == 1) revert BlanketApprovalForbidden();
            if (!callRuleSpender[ruleKey][operator]) revert SpenderNotAllowlisted(operator);
            return (0, target, false);
        }
        // D-2 curated vault set: deposit(uint256 assets, address receiver) — ERC-4626
        // canonical static shape. Pin the recipient (receiver == self | ∈ allowlist),
        // charge `assets` against the per-call cap + the cumulative budget keyed by the
        // VAULT address (a legible per-vault cap, not the underlying asset the vault
        // pulls — that pull is separately bounded by the governed `approve` envelope).
        // Autonomous yield deposits are legible on-chain: a
        // hijacked session key can never redirect the minted shares to an attacker.
        // Returns no bool (deposit returns uint256 shares), so no SafeERC20 check.
        if (selector == SEL_DEPOSIT) {
            if (data.length != 4 + 64) revert DecodeMismatch();
            uint256 assets = _decodeUint(data, 4);
            address receiver = _decodeAddress(data, 36);
            _checkRecipient(receiver, rule.recipientMode);
            return (assets, target, false);
        }
        // SE-8 governed bridging (E-9) — OP-stack bridge family, strict canonical.
        // The recipient pin IS the same-address guarantee: recipientMode=0 requires
        // `to == address(this)`, and the account sits at the SAME CREATE2 address on
        // every chain (SD-E9) — so far-chain funds can only land on the leashed
        // account itself. `extraData` is forced EMPTY (canonical 0x60/0xc0 head
        // offset + zero length): bridging never needs it, and an arbitrary-bytes
        // tail would be an opaque payload surface the wall cannot read.
        if (selector == SEL_BRIDGE_ETH_TO) {
            // bridgeETHTo(address to, uint32 minGasLimit, bytes extraData)
            if (data.length != 4 + 128) revert DecodeMismatch();
            address to = _decodeAddress(data, 4);
            uint256 minGas = _decodeUint(data, 36);
            if (minGas >> 32 != 0) revert DecodeMismatch();
            if (_decodeUint(data, 68) != 0x60) revert DecodeMismatch(); // extraData head offset
            if (_decodeUint(data, 100) != 0) revert DecodeMismatch(); // extraData length == 0
            // E-12 M-02: bridge recipients are pinned to SELF unconditionally —
            // recipientMode is IGNORED for bridge legs. A home-chain allowlist
            // entry says nothing about who controls that address on the
            // DESTINATION chain (a contract there may be a different party);
            // only the same-CREATE2-address account is a verifiable far-chain
            // recipient. Non-self far-chain payouts go through the owner
            // one-shot lane (exact owner-reviewed bytes), never a standing rule.
            if (to != address(this)) revert RecipientNotSelf(to);
            // the bridged amount is msg.value — charged against the NATIVE budget.
            return (value, address(0), false);
        }
        if (selector == SEL_BRIDGE_ERC20_TO) {
            // bridgeERC20To(address localToken, address remoteToken, address to,
            //               uint256 amount, uint32 minGasLimit, bytes extraData)
            if (data.length != 4 + 224) revert DecodeMismatch();
            if (value != 0) revert DecodeMismatch(); // nonpayable: value may never ride uncharged
            address localToken = _decodeAddress(data, 4);
            _decodeAddress(data, 36); // remoteToken — canonical check only
            address to = _decodeAddress(data, 68);
            uint256 amount = _decodeUint(data, 100);
            uint256 minGas = _decodeUint(data, 132);
            if (minGas >> 32 != 0) revert DecodeMismatch();
            if (_decodeUint(data, 164) != 0xc0) revert DecodeMismatch(); // extraData head offset
            if (_decodeUint(data, 196) != 0) revert DecodeMismatch(); // extraData length == 0
            // E-12 M-02: recipient pinned to SELF unconditionally (see bridgeETHTo).
            if (to != address(this)) revert RecipientNotSelf(to);
            // E-12 M-01: charge `amount` against the LOCAL TOKEN's budget — a
            // bridge-keyed budget is unit-blind when one bridge serves tokens of
            // different decimals (a "1000 USDC" cap would meaninglessly bound a
            // WETH leg). Token-keyed = the cap is denominated in the asset that
            // actually moves. NOTE the conservative additive accounting: the
            // enabling `approve(bridge, amount)` leg debits the SAME token
            // budget, so a bridged unit consumes ~2 units of token budget —
            // fail-closed narrowing, never a widening.
            return (amount, localToken, false);
        }
        // Non-structured allowlisted selector: bound msg.value against the native
        // budget; the off-chain gate supplies rich arg legibility + recursive unwrap.
        return (value, address(0), false);
    }

    /// @dev The structured ERC-20 selectors that return a bool we SafeERC20-check.
    ///      NOTE (M-02 audit): `increaseAllowance` accumulates allowance additively,
    ///      so its per-call cap bounds ONE leg; the standing allowance ceiling for a
    ///      granted increaseAllowance rule is `windowCapCall` (a bounded, owner-set
    ///      value). `approve` OVERWRITES, so an approve rule's standing allowance is
    ///      always ≤ perCallCap. Both are owner-bounded; neither can reach infinity
    ///      (approve(max) is banned).
    function _isBoolReturningSelector(bytes4 selector) internal pure returns (bool) {
        return selector == SEL_APPROVE || selector == SEL_INCREASE_ALLOWANCE || selector == SEL_TRANSFER
            || selector == SEL_TRANSFER_FROM;
    }

    function _checkRecipient(address to, uint8 recipientMode) internal view {
        if (recipientMode == 0) {
            if (to != address(this)) revert RecipientNotSelf(to);
        } else {
            if (!allowlist[to]) revert NotAllowlisted(to);
        }
    }

    /// @dev Strict canonical address decode: the word's upper 96 bits MUST be zero.
    function _decodeAddress(bytes calldata data, uint256 offset) internal pure returns (address) {
        bytes32 word = bytes32(data[offset:offset + 32]);
        if (uint256(word) >> 160 != 0) revert DecodeMismatch();
        return address(uint160(uint256(word)));
    }

    function _decodeUint(bytes calldata data, uint256 offset) internal pure returns (uint256) {
        return uint256(bytes32(data[offset:offset + 32]));
    }

    function _debitSpendBudget(address token, uint256 amount, uint32 windowSeconds) internal {
        SpendBudget storage b = spendBudget[token];
        if (!b.set) revert BudgetNotSet(token);
        if (block.timestamp >= uint256(b.windowStart) + windowSeconds) {
            b.windowStart = uint64(block.timestamp);
            b.spent = 0;
        }
        uint256 attempted = uint256(b.spent) + amount;
        if (attempted > b.windowCap) revert OverCumulativeSpend(attempted, b.windowCap);
        b.spent = uint128(attempted);
    }

    function _debitCallWindow(bytes32 ruleKey, uint256 amount, uint32 windowSeconds) internal {
        CallRule storage r = callRules[ruleKey];
        if (block.timestamp >= uint256(r.windowStartCall) + windowSeconds) {
            r.windowStartCall = uint64(block.timestamp);
            r.spentInWindowCall = 0;
        }
        uint256 attempted = uint256(r.spentInWindowCall) + amount;
        if (attempted > r.windowCapCall) revert OverCallWindowCap(attempted, r.windowCapCall);
        r.spentInWindowCall = uint128(attempted);
    }

    // ---------- JIT Lane-2: one-shot exact-call authorization (INSTANT) ----------

    /// @notice Authorize ONE exact owner-reviewed call (approve-once). `callHash` =
    ///         keccak256(abi.encode(target, selector, data, value)). Consumed on the
    ///         first matching `executeCall`; not a standing widen, so instant.
    function authorizeOnce(bytes32 callHash, uint64 expiry) external onlyOwner {
        if (expiry <= block.timestamp) revert OneShotExpired();
        oneShotAuthEta[callHash] = expiry;
        emit OneShotAuthorized(callHash, expiry);
    }

    // ---------- Lane-3: governed-calldata grant grammar ----------

    /// @dev Adding a target/selector or raising a cap is LOOSENING → timelocked.
    function proposeCallRule(
        address target,
        bytes4 selector,
        uint8 recipientMode,
        address[] calldata spenders,
        uint128 perCallCap,
        uint128 windowCapCall,
        bytes32 codehash
    ) external onlyOwner {
        if (target == address(0) || target == address(this)) revert ZeroAddress();
        if (recipientMode > 1) revert InvalidPolicy();
        pendingCallRule = PendingCallRule({
            target: target,
            selector: selector,
            recipientMode: recipientMode,
            perCallCap: perCallCap,
            windowCapCall: windowCapCall,
            codehash: codehash,
            eta: uint64(block.timestamp) + timelockDelay
        });
        delete pendingCallRuleSpenders;
        for (uint256 i = 0; i < spenders.length; i++) {
            if (spenders[i] == address(0)) revert ZeroAddress();
            pendingCallRuleSpenders.push(spenders[i]);
        }
        emit CallRuleProposed(target, selector, pendingCallRule.eta);
    }

    function applyCallRule() external onlyOwner {
        PendingCallRule memory pr = pendingCallRule;
        if (pr.eta == 0) revert NothingPending();
        if (block.timestamp < pr.eta) revert TimelockNotElapsed(pr.eta);
        callTargetAllowlist[pr.target] = true;
        bytes32 ruleKey = keccak256(abi.encodePacked(pr.target, pr.selector));
        CallRule storage r = callRules[ruleKey];
        r.allowed = true;
        r.recipientMode = pr.recipientMode;
        r.perCallCap = pr.perCallCap;
        r.windowCapCall = pr.windowCapCall;
        // window counters intentionally preserved across a re-grant (no free reset).
        uint256 spenderLen = pendingCallRuleSpenders.length;
        for (uint256 i = 0; i < spenderLen; i++) {
            callRuleSpender[ruleKey][pendingCallRuleSpenders[i]] = true;
        }
        callTargetCodehash[pr.target] = pr.codehash;
        emit CallRuleChanged(pr.target, pr.selector, pr.perCallCap, pr.windowCapCall);
        delete pendingCallRule;
        delete pendingCallRuleSpenders;
    }

    /// @notice Tighten an EXISTING rule's caps (lower only). INSTANT. Clears pending.
    function tightenCallRule(address target, bytes4 selector, uint128 perCallCap, uint128 windowCapCall)
        external
        onlyOwner
    {
        bytes32 ruleKey = keccak256(abi.encodePacked(target, selector));
        CallRule storage r = callRules[ruleKey];
        if (!r.allowed) revert SelectorNotAllowlisted(selector);
        if (perCallCap > r.perCallCap || windowCapCall > r.windowCapCall) revert NotTightening();
        r.perCallCap = perCallCap;
        r.windowCapCall = windowCapCall;
        _clearPendingTimelocks();
        emit CallRuleChanged(target, selector, perCallCap, windowCapCall);
    }

    /// @dev A removal is a TIGHTENING → clears ALL pending slots (L-02 audit), so a
    ///      matured loosening can never stay armed after a tighten/removal.
    function removeCallSelector(address target, bytes4 selector) external onlyOwner {
        bytes32 ruleKey = keccak256(abi.encodePacked(target, selector));
        delete callRules[ruleKey];
        _clearPendingTimelocks();
        emit CallRuleRemoved(target, selector);
    }

    function removeCallTarget(address target) external onlyOwner {
        callTargetAllowlist[target] = false;
        callTargetCodehash[target] = bytes32(0);
        _clearPendingTimelocks();
        emit CallTargetRemoved(target);
    }

    // ---------- per-token cumulative outflow budget (the spine) ----------

    /// @notice Raise/add a per-token cumulative outflow budget — LOOSENING → timelocked.
    function proposeSpendBudget(address token, uint128 windowCap) external onlyOwner {
        pendingBudgetToken = token;
        pendingBudgetWindowCap = windowCap;
        pendingBudgetEta = uint64(block.timestamp) + timelockDelay;
        emit SpendBudgetProposed(token, windowCap, pendingBudgetEta);
    }

    function applySpendBudget() external onlyOwner {
        uint64 eta = pendingBudgetEta;
        if (eta == 0) revert NothingPending();
        if (block.timestamp < eta) revert TimelockNotElapsed(eta);
        address token = pendingBudgetToken;
        SpendBudget storage b = spendBudget[token];
        if (!b.set) {
            b.set = true;
            b.windowStart = uint64(block.timestamp);
        }
        b.windowCap = pendingBudgetWindowCap;
        emit SpendBudgetChanged(token, pendingBudgetWindowCap);
        _clearPendingBudget();
    }

    /// @notice Lower a per-token budget — INSTANT (tightening). Clears pending.
    function tightenSpendBudget(address token, uint128 windowCap) external onlyOwner {
        SpendBudget storage b = spendBudget[token];
        if (!b.set) revert BudgetNotSet(token);
        if (windowCap > b.windowCap) revert NotTightening();
        b.windowCap = windowCap;
        _clearPendingTimelocks();
        emit SpendBudgetChanged(token, windowCap);
    }

    // ---------- revoke / re-arm ----------

    function _clearPendingCallRule() internal {
        delete pendingCallRule;
        delete pendingCallRuleSpenders;
    }

    function _clearPendingBudget() internal {
        pendingBudgetToken = address(0);
        pendingBudgetWindowCap = 0;
        pendingBudgetEta = 0;
    }

    function _clearPendingTimelocks() internal {
        delete pendingPolicy;
        pendingPolicyEta = 0;
        pendingAllowlistAddr = address(0);
        pendingAllowlistEta = 0;
        pendingWithdrawTo = address(0);
        pendingWithdrawAmount = 0;
        pendingWithdrawEta = 0;
        delete pendingTokenPolicy;
        pendingTokenPolicyEta = 0;
        _clearPendingCallRule();
        _clearPendingBudget();
    }

    function revoke() external {
        if (msg.sender != owner && msg.sender != guardian) revert NotGuardianOrOwner();
        revoked = true;
        _clearPendingTimelocks();
        emit Revoked(msg.sender);
    }

    function rearm() external onlyOwner {
        if (!revoked) revert AccountNotRevoked();
        revoked = false;
        emit Rearmed(msg.sender);
    }

    // ---------- roles ----------

    function setSessionKey(address k) external onlyOwner {
        if (k == address(0)) revert ZeroAddress();
        emit SessionKeyChanged(sessionKey, k);
        sessionKey = k;
    }

    function setGuardian(address g) external onlyOwner {
        emit GuardianChanged(guardian, g);
        guardian = g;
    }

    // ---------- native policy: tightening instant, loosening timelocked ----------

    function _isLoosening(Policy memory p) internal view returns (bool) {
        Policy memory cur = policy;
        return p.perTransferCap > cur.perTransferCap || p.windowCap > cur.windowCap
            || p.windowSeconds < cur.windowSeconds || p.expiresAt > cur.expiresAt;
    }

    function tightenPolicy(Policy calldata p) external onlyOwner {
        if (p.windowSeconds == 0) revert InvalidPolicy();
        if (_isLoosening(p)) revert NotTightening();
        policy = p;
        _clearPendingTimelocks();
        emit PolicyChanged(p);
    }

    function proposePolicy(Policy calldata p) external onlyOwner {
        if (p.windowSeconds == 0) revert InvalidPolicy();
        if (!_isLoosening(p)) revert NotLoosening();
        pendingPolicy = p;
        pendingPolicyEta = uint64(block.timestamp) + timelockDelay;
        emit PolicyProposed(p, pendingPolicyEta);
    }

    function applyPolicy() external onlyOwner {
        uint64 eta = pendingPolicyEta;
        if (eta == 0) revert NothingPending();
        if (block.timestamp < eta) revert TimelockNotElapsed(eta);
        policy = pendingPolicy;
        delete pendingPolicy;
        pendingPolicyEta = 0;
        emit PolicyChanged(policy);
    }

    // ---------- token policy: tightening instant, loosening timelocked ----------

    function _isTokenLoosening(TokenPolicy memory p) internal view returns (bool) {
        TokenPolicy memory cur = tokenPolicy;
        return p.perTransferCapToken > cur.perTransferCapToken || p.windowCapToken > cur.windowCapToken;
    }

    function tightenTokenPolicy(TokenPolicy calldata p) external onlyOwner {
        if (settlementToken == address(0)) revert NoSettlementToken();
        if (_isTokenLoosening(p)) revert NotTightening();
        tokenPolicy = p;
        _clearPendingTimelocks();
        emit TokenPolicyChanged(p);
    }

    function proposeTokenPolicy(TokenPolicy calldata p) external onlyOwner {
        if (settlementToken == address(0)) revert NoSettlementToken();
        if (!_isTokenLoosening(p)) revert NotLoosening();
        pendingTokenPolicy = p;
        pendingTokenPolicyEta = uint64(block.timestamp) + timelockDelay;
        emit TokenPolicyProposed(p, pendingTokenPolicyEta);
    }

    function applyTokenPolicy() external onlyOwner {
        uint64 eta = pendingTokenPolicyEta;
        if (eta == 0) revert NothingPending();
        if (block.timestamp < eta) revert TimelockNotElapsed(eta);
        tokenPolicy = pendingTokenPolicy;
        delete pendingTokenPolicy;
        pendingTokenPolicyEta = 0;
        emit TokenPolicyChanged(tokenPolicy);
    }

    // ---------- allowlist: additions timelocked, removals instant ----------

    function proposeAllowlist(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        pendingAllowlistAddr = to;
        pendingAllowlistEta = uint64(block.timestamp) + timelockDelay;
        emit AllowlistProposed(to, pendingAllowlistEta);
    }

    function applyAllowlist() external onlyOwner {
        uint64 eta = pendingAllowlistEta;
        if (eta == 0) revert NothingPending();
        if (block.timestamp < eta) revert TimelockNotElapsed(eta);
        allowlist[pendingAllowlistAddr] = true;
        emit AllowlistAdded(pendingAllowlistAddr);
        pendingAllowlistAddr = address(0);
        pendingAllowlistEta = 0;
    }

    function removeAllowlist(address to) external onlyOwner {
        allowlist[to] = false;
        emit AllowlistRemoved(to);
    }

    // ---------- withdraw: always timelocked, owner-only ----------

    function proposeWithdraw(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        pendingWithdrawTo = to;
        pendingWithdrawAmount = amount;
        pendingWithdrawEta = uint64(block.timestamp) + timelockDelay;
        emit WithdrawProposed(to, amount, pendingWithdrawEta);
    }

    function applyWithdraw() external onlyOwner nonReentrant {
        uint64 eta = pendingWithdrawEta;
        if (eta == 0) revert NothingPending();
        if (block.timestamp < eta) revert TimelockNotElapsed(eta);
        address to = pendingWithdrawTo;
        uint256 amount = pendingWithdrawAmount;
        pendingWithdrawTo = address(0);
        pendingWithdrawAmount = 0;
        pendingWithdrawEta = 0;
        emit WithdrawExecuted(to, amount);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert CallFailed();
    }
}
