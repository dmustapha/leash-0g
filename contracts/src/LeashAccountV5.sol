// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @dev Minimal Chainlink feed surface — the ONLY method the oracle-aware wall
///      reads. Byte-identical to `AggregatorV3Interface.latestRoundData()` so a
///      mock feed and a real Chainlink feed are swap-compatible by address alone.
interface IAggregatorV3Minimal {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @dev FP-CARRY-2 (M-02): the decimals surface the band grant fns pin on the PRICED
///      asset (must be 18dp) so a non-18dp asset can't silently defeat the premium math.
interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

/// @title LeashAccountV5 — self-enforcing constrained account with GOVERNED CALLDATA
///        + GOVERNED SIGNING (Stage F′, the account's FIRST ERC-1271 capability).
/// @notice A NEW immutable version (legacy v2/v3 + V4 bytecode UNTOUCHED, byte-identical,
///         reproducible). V5 is the full V4 governed-calldata wall VERBATIM, plus:
///
///         1. **Governed signing (ERC-1271).** `isValidSignature(bytes32,bytes)` returns
///            the magic value ONLY for an EIP-712 intent the owner's descriptor-driven
///            signing-intent policy permits AND that stays within the SAME per-token
///            `executeCall` outflow budget ("signing ≤ calling", the load-bearing
///            invariant). Because ERC-1271 is `view` (protocols `staticcall` it, so it
///            cannot debit a budget), enforcement runs in a STATEFUL pre-authorization:
///            the session key submits the intent via `authorizeSigningIntent` (mutating)
///            which validates the descriptor + policy, debits the shared per-token
///            budget, and ARMS the digest; `isValidSignature` is then a pure armed-lookup
///            that is default-deny and fails-closed on revoke/expiry. This mirrors the
///            Stage-D one-shot (`authorizeOnce`) pattern exactly.
///         2. **Config-extensible descriptor registry.** A protocol is onboarded as a
///            reviewed `signingIntentPolicy[descriptorId]` row (domain separator +
///            typeHash + field-role indices + token binding + caps + spender set) — the
///            Stage-E "a new chain is config, not code" pattern applied to signing.
///            Adding a protocol changes NO code path (FP-e). A typed-data with no
///            descriptor is REFUSED, never inferred (`00 §9` un-readable-signature drain).
///         3. **FP-CARRY V5 hardening** the immutable V4 could not take:
///            · FP-CARRY-1: the DEX `swap` becomes a STRUCTURED decode — recipient pinned
///              (offset 132) + `amountIn` charged against `tokenIn`'s budget + per-call cap
///              + window (closes the V4 open swap-exfil + swap-size spine rows).
///            · FP-CARRY-2: band grant fns assert the priced asset is 18dp.
///            · FP-CARRY-3: `requireBandForSwap` covers the `SEL_SWAP` selector; each
///              additional swap venue needs its own band+latch entry (documented).
///            · FP-CARRY-4: an INSTANT tighten clears ONLY its own pending timelock slot
///              (never a sibling dimension's deliberate pending loosening); `revoke` still
///              clears ALL (fail-closed).
/// @dev    All V4 semantics — default-deny, no-delegatecall-by-construction, strict
///         canonical decode, the multi-leg cumulative per-token budget spine, the
///         asymmetric timelock (loosen=timelocked / tighten=instant), the oracle
///         price-band — are preserved verbatim; only the four carries + the signing
///         layer are added.
contract LeashAccountV5 is ReentrancyGuard {
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
    struct CallRule {
        bool allowed;
        uint8 recipientMode;
        uint128 perCallCap;
        uint128 windowCapCall;
        uint128 spentInWindowCall;
        uint64 windowStartCall;
    }

    struct SpendBudget {
        bool set;
        uint128 windowCap;
        uint128 spent;
        uint64 windowStart;
    }

    // ---------- Stage F′ — governed-signing types ----------

    /// @notice A reviewed, config-extensible signing descriptor + its owner grant, in one
    ///         registry row. `domainSeparator` is the protocol's chainId-bound EIP-712
    ///         domain separator (replay immunity across chains). `typeHash` is the
    ///         primaryType hash. The struct is a FLAT ordered list of `numFields` static
    ///         32-byte words; `spenderIndex`/`amountIndex`/`deadlineIndex` name the role
    ///         words. `token` binds the amount to a per-token budget (the SAME budget the
    ///         `executeCall` wall debits — signing ≤ calling). `perIntentCap` +
    ///         `maxDeadlineWindow` are the owner caps.
    /// @dev    SCOPE (FP-1 spine, honest boundary): the on-chain reconstruction supports
    ///         structs whose fields are all static 32-byte words (address/uint/bytes32/
    ///         bool) — this covers ERC-2612, CoW orders, Hyperliquid orders, flat
    ///         permits. A protocol whose EIP-712 struct nests a sub-struct (e.g. Permit2
    ///         `PermitSingle`) is onboarded by the off-chain engine supplying the flattened
    ///         field layout, or a v-next on-chain extension — surfaced to Dami, FP-3 scope.
    struct SigningIntentPolicy {
        bool set;
        bytes32 domainSeparator;
        bytes32 typeHash;
        uint8 numFields;
        uint8 spenderIndex;
        uint8 amountIndex;
        uint8 deadlineIndex;
        address token;
        uint128 perIntentCap;
        uint64 maxDeadlineWindow;
    }

    /// @notice An armed EIP-712 digest the pre-authorization accepted — the view
    ///         `isValidSignature` returns the magic value ONLY while armed + unexpired.
    struct ArmedIntent {
        bool set;
        uint64 expiry;
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
    // Stage E (SE-9, L-01)
    error RemoteTokenNotPinned(address localToken);
    error RemoteTokenMismatch(address expected, address got);
    // RH slice — oracle-aware price-band
    error PremiumBreach(uint256 impliedPrice, uint256 maxPrice);
    error StaleOracle(uint256 updatedAt, uint256 maxStaleness);
    error OraclePriceInvalid();
    error OracleCallFailed();
    error PriceBandAssetMismatch(address expected, address got);
    error BandOnlyForSwap(bytes4 selector);
    error BandRequired(address target);
    error FeedNotEightDecimals(uint8 got);
    // Stage F′ — governed signing + FP-CARRY-2
    error DescriptorNotRegistered(uint256 descriptorId);
    error BadIntentSignature();
    error DeadlineInPast();
    error DeadlineTooFar(uint256 deadline);
    error AssetNotEighteenDecimals(uint8 got);

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
    event BridgeRemoteTokenProposed(address indexed localToken, address indexed remoteToken, uint64 eta);
    event BridgeRemoteTokenChanged(address indexed localToken, address indexed remoteToken);
    event PriceBandProposed(bytes32 indexed ruleKey, address feed, address asset, uint32 maxDeviationBps, uint64 maxStaleness, uint64 eta);
    event PriceBandChanged(bytes32 indexed ruleKey, address feed, address asset, uint32 maxDeviationBps, uint64 maxStaleness);
    // Stage F′ — governed signing
    event SigningGrantProposed(uint256 indexed descriptorId, uint64 eta);
    event SigningGrantChanged(uint256 indexed descriptorId, address token, uint128 perIntentCap);
    event SigningDescriptorRemoved(uint256 indexed descriptorId);
    event SigningIntentAuthorized(uint256 indexed descriptorId, bytes32 indexed digest, address spender, uint256 amount, uint64 deadline);
    event SigningIntentDisarmed(bytes32 indexed digest);

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
    bytes4 internal constant SEL_APPROVE = 0x095ea7b3;
    bytes4 internal constant SEL_INCREASE_ALLOWANCE = 0x39509351;
    bytes4 internal constant SEL_TRANSFER = 0xa9059cbb;
    bytes4 internal constant SEL_TRANSFER_FROM = 0x23b872dd;
    bytes4 internal constant SEL_SET_APPROVAL_FOR_ALL = 0xa22cb465;
    bytes4 internal constant SEL_DEPOSIT = 0x6e553f65;
    bytes4 internal constant SEL_BRIDGE_ETH_TO = 0xe11013dd;
    bytes4 internal constant SEL_BRIDGE_ERC20_TO = 0x540abf73;
    bytes4 internal constant SEL_OUTBOUND_TRANSFER = 0x7b3a3c8b;
    bytes4 internal constant SEL_WITHDRAW_ETH = 0x25e16063;
    bytes4 internal constant SEL_SWAP = 0x9908fc8b;

    mapping(address => bool) public callTargetAllowlist;
    mapping(bytes32 => CallRule) public callRules;
    mapping(bytes32 => mapping(address => bool)) public callRuleSpender;
    mapping(address => bytes32) public callTargetCodehash;
    mapping(address => SpendBudget) public spendBudget;
    mapping(bytes32 => uint64) public oneShotAuthEta;
    mapping(address => address) public bridgeRemoteToken;

    // ---------- RH slice: oracle-aware price-band policy ----------
    struct PriceBandPolicy {
        bool set;
        address feed;
        address asset;
        uint32 maxDeviationBps;
        uint64 maxStaleness;
    }

    mapping(bytes32 => PriceBandPolicy) public priceBand;
    bool public requireBandForSwap;

    bytes32 public pendingBandRuleKey;
    PriceBandPolicy public pendingBand;
    uint64 public pendingBandEta;

    struct PendingCallRule {
        address target;
        bytes4 selector;
        uint8 recipientMode;
        uint128 perCallCap;
        uint128 windowCapCall;
        bytes32 codehash;
        uint64 eta;
    }

    PendingCallRule public pendingCallRule;
    address[] internal pendingCallRuleSpenders;

    address public pendingBudgetToken;
    uint128 public pendingBudgetWindowCap;
    uint64 public pendingBudgetEta;

    address public pendingRemoteLocalToken;
    address public pendingRemoteTokenValue;
    uint64 public pendingRemoteTokenEta;

    // ---------- Stage F′ state: governed signing ----------
    bytes4 internal constant ERC1271_MAGIC = 0x1626ba7e; // bytes4(keccak256("isValidSignature(bytes32,bytes)"))
    bytes4 internal constant ERC1271_INVALID = 0xffffffff;

    mapping(uint256 => SigningIntentPolicy) public signingIntentPolicy; // descriptorId => policy
    mapping(uint256 => mapping(address => bool)) public signingSpender; // descriptorId => spender => allowed
    mapping(uint256 => address[]) internal signingSpenderList; // descriptorId => spenders (so a re-grant/remove clears cleanly)
    mapping(bytes32 => ArmedIntent) public armedIntent; // eip712 digest => armed

    /// @notice Co-signer seam (FP-4, `07 #15`). INERT in FP-1: `coSigner == address(0)`
    ///         ⇒ the hook is a no-op. FP-4 adds the owner setter + the second-factor
    ///         enforcement for cross-chain real value (real value stays gated by `07 #16`).
    address public coSigner;

    struct PendingSigningGrant {
        uint256 descriptorId;
        bytes32 domainSeparator;
        bytes32 typeHash;
        uint8 numFields;
        uint8 spenderIndex;
        uint8 amountIndex;
        uint8 deadlineIndex;
        address token;
        uint128 perIntentCap;
        uint64 maxDeadlineWindow;
        uint64 eta;
    }

    PendingSigningGrant public pendingSigningGrant;
    address[] internal pendingSigningSpenders;

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
        bytes32 callHash = keccak256(abi.encode(block.chainid, target, selector, data, value));

        uint64 osEta = oneShotAuthEta[callHash];
        if (osEta != 0) {
            if (block.timestamp > osEta) revert OneShotExpired();
            if (_isBridgeSelector(selector)) _checkBridgeArgs(selector, value, data);
            {
                bytes32 osRuleKey = keccak256(abi.encodePacked(target, selector));
                if (requireBandForSwap && selector == SEL_SWAP && !priceBand[osRuleKey].set) {
                    revert BandRequired(target);
                }
                _checkPriceBand(osRuleKey, selector, data);
            }
            delete oneShotAuthEta[callHash];
            emit OneShotConsumed(callHash);
            emit CallExecuted(target, selector, value, true);
            (bool okOnce, bool emptyOnce, bytes32 retOnce) = _boundedCall(target, value, data);
            if (!okOnce) revert CallFailed();
            if (_isBoolReturningSelector(selector) && !emptyOnce && retOnce != bytes32(uint256(1))) {
                revert TokenTransferFailed();
            }
            return;
        }

        if (!callTargetAllowlist[target]) revert TargetNotAllowlisted(target);
        bytes32 pin = callTargetCodehash[target];
        if (pin != bytes32(0) && target.codehash != pin) revert CodehashMismatch();
        _enforceAndExecute(target, selector, value, data, p.windowSeconds);
    }

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

        if (requireBandForSwap && selector == SEL_SWAP && !priceBand[ruleKey].set) revert BandRequired(target);
        _checkPriceBand(ruleKey, selector, data);

        (uint256 chargeable, address spendToken, bool checkBoolReturn) =
            _checkStructuredArgs(target, selector, value, data, ruleKey, rule);

        if (chargeable > rule.perCallCap) revert OverPerCallCap(chargeable, rule.perCallCap);

        if (chargeable > 0) {
            _debitSpendBudget(spendToken, chargeable, windowSeconds);
        }
        _debitCallWindow(ruleKey, chargeable, windowSeconds);

        emit CallExecuted(target, selector, chargeable, false);

        (bool ok, bool empty, bytes32 retWord) = _boundedCall(target, value, data);
        if (!ok) revert CallFailed();
        if (checkBoolReturn && !empty && retWord != bytes32(uint256(1))) {
            revert TokenTransferFailed();
        }
    }

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
            if (from != address(this)) revert RecipientNotSelf(from);
            _checkRecipient(to, rule.recipientMode);
            return (amount, target, true);
        }
        if (selector == SEL_SET_APPROVAL_FOR_ALL) {
            if (data.length != 4 + 64) revert DecodeMismatch();
            address operator = _decodeAddress(data, 4);
            uint256 approvedRaw = _decodeUint(data, 36);
            if (approvedRaw > 1) revert DecodeMismatch();
            if (approvedRaw == 1) revert BlanketApprovalForbidden();
            if (!callRuleSpender[ruleKey][operator]) revert SpenderNotAllowlisted(operator);
            return (0, target, false);
        }
        if (selector == SEL_DEPOSIT) {
            if (data.length != 4 + 64) revert DecodeMismatch();
            uint256 assets = _decodeUint(data, 4);
            address receiver = _decodeAddress(data, 36);
            _checkRecipient(receiver, rule.recipientMode);
            return (assets, target, false);
        }
        // FP-CARRY-1 (RH2 H-01): the DEX swap is STRUCTURED on V5. On V4 `SEL_SWAP`
        // fell through to the non-structured fallback — recipient UNPINNED, `amountIn`
        // UNBUDGETED (an OPEN on-chain spine residual). V5 decodes the static 6-arg
        // swap(tokenIn, tokenOut, amountIn, amountOutMin, recipient, deadline): pin the
        // recipient (offset 132) via `_checkRecipient` AND charge `amountIn` (offset 68)
        // against `tokenIn`'s (offset 4) cumulative budget + per-call cap + window. One
        // addition closes BOTH open rows (swap-exfil + swap-size). The price-band
        // (`_checkPriceBand`, run in `_enforceAndExecute`) independently bounds PRICE.
        if (selector == SEL_SWAP) {
            if (data.length != 4 + 192) revert DecodeMismatch();
            address tokenIn = _decodeAddress(data, 4);
            uint256 amountIn = _decodeUint(data, 68);
            address recipient = _decodeAddress(data, 132);
            _checkRecipient(recipient, rule.recipientMode);
            return (amountIn, tokenIn, false);
        }
        if (_isBridgeSelector(selector)) {
            return _checkBridgeArgs(selector, value, data);
        }
        return (value, address(0), false);
    }

    function _isBridgeSelector(bytes4 selector) internal pure returns (bool) {
        return selector == SEL_BRIDGE_ETH_TO || selector == SEL_BRIDGE_ERC20_TO
            || selector == SEL_WITHDRAW_ETH || selector == SEL_OUTBOUND_TRANSFER;
    }

    function _checkBridgeArgs(bytes4 selector, uint256 value, bytes calldata data)
        internal
        view
        returns (uint256 chargeable, address spendToken, bool checkBoolReturn)
    {
        if (selector == SEL_BRIDGE_ETH_TO) {
            if (data.length != 4 + 128) revert DecodeMismatch();
            address to = _decodeAddress(data, 4);
            uint256 minGas = _decodeUint(data, 36);
            if (minGas >> 32 != 0) revert DecodeMismatch();
            if (_decodeUint(data, 68) != 0x60) revert DecodeMismatch();
            if (_decodeUint(data, 100) != 0) revert DecodeMismatch();
            if (to != address(this)) revert RecipientNotSelf(to);
            return (value, address(0), false);
        }
        if (selector == SEL_BRIDGE_ERC20_TO) {
            if (data.length != 4 + 224) revert DecodeMismatch();
            if (value != 0) revert DecodeMismatch();
            address localToken = _decodeAddress(data, 4);
            address remoteToken = _decodeAddress(data, 36);
            address to = _decodeAddress(data, 68);
            uint256 amount = _decodeUint(data, 100);
            uint256 minGas = _decodeUint(data, 132);
            if (minGas >> 32 != 0) revert DecodeMismatch();
            if (_decodeUint(data, 164) != 0xc0) revert DecodeMismatch();
            if (_decodeUint(data, 196) != 0) revert DecodeMismatch();
            if (to != address(this)) revert RecipientNotSelf(to);
            address pinned = bridgeRemoteToken[localToken];
            if (pinned == address(0)) revert RemoteTokenNotPinned(localToken);
            if (remoteToken != pinned) revert RemoteTokenMismatch(pinned, remoteToken);
            return (amount, localToken, false);
        }
        if (selector == SEL_OUTBOUND_TRANSFER) {
            if (data.length != 4 + 160) revert DecodeMismatch();
            if (value != 0) revert DecodeMismatch();
            address l1Token = _decodeAddress(data, 4);
            address to = _decodeAddress(data, 36);
            uint256 amount = _decodeUint(data, 68);
            if (_decodeUint(data, 100) != 0x80) revert DecodeMismatch();
            if (_decodeUint(data, 132) != 0) revert DecodeMismatch();
            if (to != address(this)) revert RecipientNotSelf(to);
            return (amount, l1Token, false);
        }
        if (data.length != 4 + 32) revert DecodeMismatch();
        address dest = _decodeAddress(data, 4);
        if (dest != address(this)) revert RecipientNotSelf(dest);
        return (value, address(0), false);
    }

    function _isBoolReturningSelector(bytes4 selector) internal pure returns (bool) {
        return selector == SEL_APPROVE || selector == SEL_INCREASE_ALLOWANCE || selector == SEL_TRANSFER
            || selector == SEL_TRANSFER_FROM;
    }

    function _checkPriceBand(bytes32 ruleKey, bytes4 selector, bytes calldata data) internal view {
        PriceBandPolicy memory band = priceBand[ruleKey];
        if (!band.set) return;
        if (selector != SEL_SWAP) revert BandOnlyForSwap(selector);
        if (data.length != 4 + 192) revert DecodeMismatch();
        address tokenOut = _decodeAddress(data, 36);
        uint256 amountIn = _decodeUint(data, 68);
        uint256 amountOutMin = _decodeUint(data, 100);
        if (tokenOut != band.asset) revert PriceBandAssetMismatch(band.asset, tokenOut);
        if (amountOutMin == 0) revert PremiumBreach(type(uint256).max, 0);

        try IAggregatorV3Minimal(band.feed).latestRoundData() returns (
            uint80 roundId, int256 answer, uint256, uint256 updatedAt, uint80 answeredInRound
        ) {
            if (answer <= 0) revert OraclePriceInvalid();
            if (updatedAt == 0 || updatedAt > block.timestamp || block.timestamp - updatedAt > band.maxStaleness) {
                revert StaleOracle(updatedAt, band.maxStaleness);
            }
            if (answeredInRound < roundId) revert OraclePriceInvalid();

            uint256 impliedPrice18 = (amountIn * 1e18) / amountOutMin;
            uint256 oracle18 = uint256(answer) * 1e10;
            uint256 maxPrice = (oracle18 * (10_000 + band.maxDeviationBps)) / 10_000;
            if (impliedPrice18 > maxPrice) revert PremiumBreach(impliedPrice18, maxPrice);
        } catch {
            revert OracleCallFailed();
        }
    }

    function _checkRecipient(address to, uint8 recipientMode) internal view {
        if (recipientMode == 0) {
            if (to != address(this)) revert RecipientNotSelf(to);
        } else {
            if (!allowlist[to]) revert NotAllowlisted(to);
        }
    }

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

    // ================= Stage F′ — governed signing (ERC-1271) =================

    /// @notice ERC-1271. Returns the magic value ONLY for a digest the session key
    ///         pre-authorized via `authorizeSigningIntent` and that has not expired.
    ///         `view`-safe (protocols `staticcall` this). Default-deny + fails-closed
    ///         on revoke/expiry: an un-armed, revoked, or expired digest is invalid.
    function isValidSignature(bytes32 hash, bytes calldata /*signature*/ ) external view returns (bytes4) {
        if (revoked) return ERC1271_INVALID; // revoke fails-closed
        ArmedIntent memory a = armedIntent[hash];
        if (a.set && block.timestamp <= a.expiry) return ERC1271_MAGIC;
        return ERC1271_INVALID;
    }

    /// @notice The STATEFUL pre-authorization (the enforcement locus — ERC-1271 being
    ///         `view` cannot debit). The session key submits the EIP-712 intent's
    ///         ordered field words + its own ECDSA signature over the digest. The wall:
    ///         reconstructs the digest from the descriptor (strict-canonical binding —
    ///         the provided fields MUST reproduce the hash a protocol will ask about),
    ///         verifies the session key signed it, checks the descriptor policy
    ///         (default-deny · spender ∈ set · amount ≤ cap · deadline bounds), DEBITS
    ///         the SAME per-token `executeCall` budget (signing ≤ calling — no independent
    ///         signing allowance; closes laddering + off-chain-order→on-chain-drain), and
    ///         ARMS the digest for `isValidSignature`. Same session-key / not-revoked /
    ///         not-expired guards as `executeCall`.
    /// @dev    SCOPE (load-bearing assumption — review-time + FP-2 engine responsibility):
    ///         the account bounds the cumulative DEBITED NOTIONAL (amount per armed intent,
    ///         summed into the per-token budget), NOT the number of times the armed ERC-1271
    ///         signature authorizes value movement. Standard permit descriptors (ERC-2612,
    ///         Permit2 allowance, CoW/HL orders) enforce their own on-chain nonce / total
    ///         allowance, so one armed digest moves at most `amount`. A descriptor for a
    ///         protocol that would honor one signature for repeated full-`amount` fills
    ///         without its own nonce is OUT OF SCOPE and must not be registered (the FP-2
    ///         engine asserts this at descriptor-review time). `amount == 0` arms a
    ///         zero-notional intent (e.g. a cancel/zero-approval) and skips the budget debit
    ///         by design — it moves no value. The owner can `disarmSigningIntent` a single
    ///         armed digest, or `revoke` to fail-close all. M-01 (accepted): an armed permit
    ///         inherits the project's <=2x-cap-across-a-window-boundary burst bound, exactly
    ///         as the calling path does (`00`/LIMITATIONS); bound by the per-window budget.
    function authorizeSigningIntent(uint256 descriptorId, bytes32[] calldata fields, bytes calldata sessionSig)
        external
        nonReentrant
        returns (bytes32 digest)
    {
        if (msg.sender != sessionKey) revert NotSessionKey();
        if (revoked) revert AccountRevoked();
        Policy memory p = policy;
        if (block.timestamp > p.expiresAt) revert SessionExpired();

        SigningIntentPolicy memory s = signingIntentPolicy[descriptorId];
        if (!s.set) revert DescriptorNotRegistered(descriptorId); // default-deny
        if (fields.length != s.numFields) revert DecodeMismatch();

        // strict-canonical binding: reconstruct the EIP-712 digest from the fields.
        bytes32 structHash = keccak256(abi.encodePacked(s.typeHash, fields));
        digest = keccak256(abi.encodePacked(hex"1901", s.domainSeparator, structHash));

        // the session key must have actually signed this exact digest.
        if (ECDSA.recover(digest, sessionSig) != sessionKey) revert BadIntentSignature();

        address spender = _fieldAddress(fields, s.spenderIndex);
        uint256 amount = uint256(fields[s.amountIndex]);
        uint256 deadline = uint256(fields[s.deadlineIndex]);

        if (!signingSpender[descriptorId][spender]) revert SpenderNotAllowlisted(spender);
        if (amount > s.perIntentCap) revert OverPerCallCap(amount, s.perIntentCap);
        if (deadline <= block.timestamp) revert DeadlineInPast();
        if (deadline > uint256(block.timestamp) + s.maxDeadlineWindow) revert DeadlineTooFar(deadline);

        // co-signer seam (FP-4) — inert while coSigner == address(0).
        _coSignerHook(descriptorId, digest, amount);

        // signing ≤ calling: debit the SAME per-token budget the executeCall wall uses.
        if (amount > 0) {
            _debitSpendBudget(s.token, amount, p.windowSeconds);
        }

        armedIntent[digest] = ArmedIntent({set: true, expiry: uint64(deadline)});
        emit SigningIntentAuthorized(descriptorId, digest, spender, amount, uint64(deadline));
    }

    /// @dev Strict canonical address decode of an EIP-712 field word (upper 96 bits zero).
    function _fieldAddress(bytes32[] calldata fields, uint8 idx) internal pure returns (address) {
        bytes32 word = fields[idx];
        if (uint256(word) >> 160 != 0) revert DecodeMismatch();
        return address(uint160(uint256(word)));
    }

    /// @dev Co-signer second-factor seam (FP-4, `07 #15`). Inert in FP-1 — there is no
    ///      setter for `coSigner` in V5, so it is permanently `address(0)` and this hook
    ///      is provably a no-op. FP-4 adds the owner setter + the activated co-signer's
    ///      approval enforcement here (cross-chain real value; real value gated by #16).
    function _coSignerHook(uint256, /*descriptorId*/ bytes32, /*digest*/ uint256 /*amount*/ ) internal view {
        if (coSigner == address(0)) return;
    }

    /// @notice Surgically disarm ONE armed signing intent — owner-only, INSTANT. Lets the
    ///         owner kill a single intent (e.g. a mis-authorized or no-longer-wanted permit)
    ///         without the global `revoke`. Does NOT refund the debited budget: a disarm
    ///         only ever REDUCES what is valid (fail-closed, consistent with the "tighten
    ///         never widens" convention). `isValidSignature` returns INVALID immediately after.
    function disarmSigningIntent(bytes32 digest) external onlyOwner {
        delete armedIntent[digest];
        emit SigningIntentDisarmed(digest);
    }

    // ---------- Stage F′ — signing grant grammar (loosen timelocked / tighten instant) ----------

    /// @notice Onboard or RE-grant a protocol: its descriptor (decode spec) + caps +
    ///         spender set, in one atomic owner grant. Adding signable surface is
    ///         LOOSENING → timelocked. Adding a protocol changes NO code path (FP-e).
    function proposeSigningGrant(
        uint256 descriptorId,
        bytes32 domainSeparator,
        bytes32 typeHash,
        uint8 numFields,
        uint8 spenderIndex,
        uint8 amountIndex,
        uint8 deadlineIndex,
        address token,
        uint128 perIntentCap,
        uint64 maxDeadlineWindow,
        address[] calldata spenders
    ) external onlyOwner {
        if (domainSeparator == bytes32(0) || typeHash == bytes32(0)) revert InvalidPolicy();
        if (token == address(0)) revert ZeroAddress();
        if (numFields == 0 || numFields > 32) revert InvalidPolicy();
        if (spenderIndex >= numFields || amountIndex >= numFields || deadlineIndex >= numFields) revert InvalidPolicy();
        pendingSigningGrant = PendingSigningGrant({
            descriptorId: descriptorId,
            domainSeparator: domainSeparator,
            typeHash: typeHash,
            numFields: numFields,
            spenderIndex: spenderIndex,
            amountIndex: amountIndex,
            deadlineIndex: deadlineIndex,
            token: token,
            perIntentCap: perIntentCap,
            maxDeadlineWindow: maxDeadlineWindow,
            eta: uint64(block.timestamp) + timelockDelay
        });
        delete pendingSigningSpenders;
        for (uint256 i = 0; i < spenders.length; i++) {
            if (spenders[i] == address(0)) revert ZeroAddress();
            pendingSigningSpenders.push(spenders[i]);
        }
        emit SigningGrantProposed(descriptorId, pendingSigningGrant.eta);
    }

    function applySigningGrant() external onlyOwner {
        PendingSigningGrant memory pg = pendingSigningGrant;
        if (pg.eta == 0) revert NothingPending();
        if (block.timestamp < pg.eta) revert TimelockNotElapsed(pg.eta);
        // clear any prior spender set for this descriptor (a re-grant replaces it).
        _clearSigningSpenders(pg.descriptorId);
        SigningIntentPolicy storage s = signingIntentPolicy[pg.descriptorId];
        s.set = true;
        s.domainSeparator = pg.domainSeparator;
        s.typeHash = pg.typeHash;
        s.numFields = pg.numFields;
        s.spenderIndex = pg.spenderIndex;
        s.amountIndex = pg.amountIndex;
        s.deadlineIndex = pg.deadlineIndex;
        s.token = pg.token;
        s.perIntentCap = pg.perIntentCap;
        s.maxDeadlineWindow = pg.maxDeadlineWindow;
        uint256 len = pendingSigningSpenders.length;
        for (uint256 i = 0; i < len; i++) {
            address sp = pendingSigningSpenders[i];
            if (!signingSpender[pg.descriptorId][sp]) {
                signingSpender[pg.descriptorId][sp] = true;
                signingSpenderList[pg.descriptorId].push(sp);
            }
        }
        emit SigningGrantChanged(pg.descriptorId, pg.token, pg.perIntentCap);
        _clearPendingSigningGrant();
    }

    /// @notice Tighten a descriptor's caps (lower perIntentCap and/or maxDeadlineWindow).
    ///         INSTANT. FP-CARRY-4: clears ONLY the pending signing-grant slot.
    /// @dev    Pass the CURRENT value for any dimension you are not lowering. NOTE a
    ///         `maxDeadlineWindow == 0` DISABLES the descriptor (every future arm reverts
    ///         `DeadlineTooFar`, since `deadline > now` always exceeds `now + 0`) — this is
    ///         a valid (maximal) tightening, not a bug, but be deliberate about it.
    function tightenSigningGrant(uint256 descriptorId, uint128 perIntentCap, uint64 maxDeadlineWindow)
        external
        onlyOwner
    {
        SigningIntentPolicy storage s = signingIntentPolicy[descriptorId];
        if (!s.set) revert DescriptorNotRegistered(descriptorId);
        if (perIntentCap > s.perIntentCap || maxDeadlineWindow > s.maxDeadlineWindow) revert NotTightening();
        s.perIntentCap = perIntentCap;
        s.maxDeadlineWindow = maxDeadlineWindow;
        _clearPendingSigningGrant();
        emit SigningGrantChanged(descriptorId, s.token, perIntentCap);
    }

    /// @notice Remove a descriptor entirely (default-deny again) — TIGHTENING → INSTANT.
    ///         Clears the spender set + ONLY the pending signing-grant slot (FP-CARRY-4).
    function removeSigningDescriptor(uint256 descriptorId) external onlyOwner {
        _clearSigningSpenders(descriptorId);
        delete signingIntentPolicy[descriptorId];
        _clearPendingSigningGrant();
        emit SigningDescriptorRemoved(descriptorId);
    }

    function _clearSigningSpenders(uint256 descriptorId) internal {
        address[] storage list = signingSpenderList[descriptorId];
        uint256 len = list.length;
        for (uint256 i = 0; i < len; i++) {
            signingSpender[descriptorId][list[i]] = false;
        }
        delete signingSpenderList[descriptorId];
    }

    // ---------- JIT Lane-2: one-shot exact-call authorization (INSTANT) ----------

    function authorizeOnce(bytes32 callHash, uint64 expiry) external onlyOwner {
        if (expiry <= block.timestamp) revert OneShotExpired();
        oneShotAuthEta[callHash] = expiry;
        emit OneShotAuthorized(callHash, expiry);
    }

    // ---------- Lane-3: governed-calldata grant grammar ----------

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
        uint256 spenderLen = pendingCallRuleSpenders.length;
        for (uint256 i = 0; i < spenderLen; i++) {
            callRuleSpender[ruleKey][pendingCallRuleSpenders[i]] = true;
        }
        callTargetCodehash[pr.target] = pr.codehash;
        emit CallRuleChanged(pr.target, pr.selector, pr.perCallCap, pr.windowCapCall);
        delete pendingCallRule;
        delete pendingCallRuleSpenders;
    }

    /// @notice Tighten an EXISTING rule's caps (lower only). INSTANT.
    ///         FP-CARRY-4: clears ONLY the pending call-rule slot (not sibling dimensions).
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
        _clearPendingCallRule();
        emit CallRuleChanged(target, selector, perCallCap, windowCapCall);
    }

    /// @dev FP-CARRY-4: a removal is a TIGHTENING → clears ONLY the pending call-rule slot.
    function removeCallSelector(address target, bytes4 selector) external onlyOwner {
        bytes32 ruleKey = keccak256(abi.encodePacked(target, selector));
        delete callRules[ruleKey];
        _clearPendingCallRule();
        emit CallRuleRemoved(target, selector);
    }

    function removeCallTarget(address target) external onlyOwner {
        callTargetAllowlist[target] = false;
        callTargetCodehash[target] = bytes32(0);
        _clearPendingCallRule();
        emit CallTargetRemoved(target);
    }

    // ---------- per-token cumulative outflow budget (the spine) ----------

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

    /// @notice Lower a per-token budget — INSTANT (tightening).
    ///         FP-CARRY-4: clears ONLY the pending budget slot.
    function tightenSpendBudget(address token, uint128 windowCap) external onlyOwner {
        SpendBudget storage b = spendBudget[token];
        if (!b.set) revert BudgetNotSet(token);
        if (windowCap > b.windowCap) revert NotTightening();
        b.windowCap = windowCap;
        _clearPendingBudget();
        emit SpendBudgetChanged(token, windowCap);
    }

    // ---------- SE-9 (L-01): the ERC-20 bridge remote-token pin ----------

    function proposeBridgeRemoteToken(address localToken, address remoteToken) external onlyOwner {
        if (localToken == address(0) || remoteToken == address(0)) revert ZeroAddress();
        pendingRemoteLocalToken = localToken;
        pendingRemoteTokenValue = remoteToken;
        pendingRemoteTokenEta = uint64(block.timestamp) + timelockDelay;
        emit BridgeRemoteTokenProposed(localToken, remoteToken, pendingRemoteTokenEta);
    }

    function applyBridgeRemoteToken() external onlyOwner {
        uint64 eta = pendingRemoteTokenEta;
        if (eta == 0) revert NothingPending();
        if (block.timestamp < eta) revert TimelockNotElapsed(eta);
        bridgeRemoteToken[pendingRemoteLocalToken] = pendingRemoteTokenValue;
        emit BridgeRemoteTokenChanged(pendingRemoteLocalToken, pendingRemoteTokenValue);
        _clearPendingRemoteToken();
    }

    /// @notice Remove a remote-token binding — TIGHTENING → INSTANT.
    ///         FP-CARRY-4: clears ONLY the pending remote-token slot.
    function removeBridgeRemoteToken(address localToken) external onlyOwner {
        delete bridgeRemoteToken[localToken];
        _clearPendingRemoteToken();
        emit BridgeRemoteTokenChanged(localToken, address(0));
    }

    // ---------- RH slice: price-band grant grammar (tighten instant, loosen timelocked) ----------

    /// @notice Add or tighten a price band — INSTANT. FP-CARRY-2: the priced asset MUST
    ///         be 18dp (mirrors the 8dp feed pin). FP-CARRY-4: clears ONLY the band slot.
    function tightenPriceBand(
        address target,
        bytes4 selector,
        address feed,
        address asset,
        uint32 maxDeviationBps,
        uint64 maxStaleness
    ) external onlyOwner {
        if (selector != SEL_SWAP) revert BandOnlyForSwap(selector);
        if (feed == address(0) || asset == address(0)) revert ZeroAddress();
        _assertFeedEightDecimals(feed);
        _assertAssetEighteenDecimals(asset); // FP-CARRY-2
        bytes32 ruleKey = keccak256(abi.encodePacked(target, selector));
        PriceBandPolicy storage b = priceBand[ruleKey];
        if (b.set) {
            if (feed != b.feed || asset != b.asset) revert NotTightening();
            if (maxDeviationBps > b.maxDeviationBps || maxStaleness > b.maxStaleness) revert NotTightening();
        }
        b.set = true;
        b.feed = feed;
        b.asset = asset;
        b.maxDeviationBps = maxDeviationBps;
        b.maxStaleness = maxStaleness;
        _clearPendingBand();
        emit PriceBandChanged(ruleKey, feed, asset, maxDeviationBps, maxStaleness);
    }

    /// @notice Loosen/re-point a price band — LOOSENING → timelocked. FP-CARRY-2 asset pin.
    function proposePriceBand(
        address target,
        bytes4 selector,
        address feed,
        address asset,
        uint32 maxDeviationBps,
        uint64 maxStaleness
    ) external onlyOwner {
        if (selector != SEL_SWAP) revert BandOnlyForSwap(selector);
        if (feed == address(0) || asset == address(0)) revert ZeroAddress();
        _assertFeedEightDecimals(feed);
        _assertAssetEighteenDecimals(asset); // FP-CARRY-2
        bytes32 ruleKey = keccak256(abi.encodePacked(target, selector));
        pendingBandRuleKey = ruleKey;
        pendingBand =
            PriceBandPolicy({set: true, feed: feed, asset: asset, maxDeviationBps: maxDeviationBps, maxStaleness: maxStaleness});
        pendingBandEta = uint64(block.timestamp) + timelockDelay;
        emit PriceBandProposed(ruleKey, feed, asset, maxDeviationBps, maxStaleness, pendingBandEta);
    }

    function applyPriceBand() external onlyOwner {
        uint64 eta = pendingBandEta;
        if (eta == 0) revert NothingPending();
        if (block.timestamp < eta) revert TimelockNotElapsed(eta);
        bytes32 ruleKey = pendingBandRuleKey;
        PriceBandPolicy memory pb = pendingBand;
        priceBand[ruleKey] = pb;
        emit PriceBandChanged(ruleKey, pb.feed, pb.asset, pb.maxDeviationBps, pb.maxStaleness);
        _clearPendingBand();
    }

    /// @notice One-way latch (H-1): once enabled, every `SEL_SWAP` call on a rule WITHOUT
    ///         a set band reverts `BandRequired`. FP-CARRY-3 (documented): the latch
    ///         covers the `SEL_SWAP` selector; onboarding a second swap venue with a
    ///         DIFFERENT selector requires its own band + (re-)latch entry — surfaced,
    ///         accepted for FP-1 (one swap selector exists). INSTANT (tightening).
    function enableRequireBandForSwap() external onlyOwner {
        requireBandForSwap = true;
    }

    function _assertFeedEightDecimals(address feed) internal view {
        uint8 d = IAggregatorV3Minimal(feed).decimals();
        if (d != 8) revert FeedNotEightDecimals(d);
    }

    /// @dev FP-CARRY-2 (M-02): the premium math assumes 18dp token legs; pin the priced
    ///      asset to 18 decimals at grant time (fail-loud) so a non-18dp asset cannot
    ///      silently defeat the band.
    function _assertAssetEighteenDecimals(address asset) internal view {
        uint8 d = IERC20Decimals(asset).decimals();
        if (d != 18) revert AssetNotEighteenDecimals(d);
    }

    // ---------- revoke / re-arm + granular pending clears (FP-CARRY-4) ----------

    function _clearPendingPolicy() internal {
        delete pendingPolicy;
        pendingPolicyEta = 0;
    }

    function _clearPendingTokenPolicy() internal {
        delete pendingTokenPolicy;
        pendingTokenPolicyEta = 0;
    }

    function _clearPendingBand() internal {
        pendingBandRuleKey = bytes32(0);
        delete pendingBand;
        pendingBandEta = 0;
    }

    function _clearPendingRemoteToken() internal {
        pendingRemoteLocalToken = address(0);
        pendingRemoteTokenValue = address(0);
        pendingRemoteTokenEta = 0;
    }

    function _clearPendingCallRule() internal {
        delete pendingCallRule;
        delete pendingCallRuleSpenders;
    }

    function _clearPendingBudget() internal {
        pendingBudgetToken = address(0);
        pendingBudgetWindowCap = 0;
        pendingBudgetEta = 0;
    }

    function _clearPendingSigningGrant() internal {
        delete pendingSigningGrant;
        delete pendingSigningSpenders;
    }

    /// @dev The full nuke — used ONLY by `revoke` (emergency, fail-closed). Every
    ///      instant tighten now clears ONLY its own slot (FP-CARRY-4); revoke clears ALL.
    function _clearPendingTimelocks() internal {
        _clearPendingPolicy();
        pendingAllowlistAddr = address(0);
        pendingAllowlistEta = 0;
        pendingWithdrawTo = address(0);
        pendingWithdrawAmount = 0;
        pendingWithdrawEta = 0;
        _clearPendingTokenPolicy();
        _clearPendingCallRule();
        _clearPendingBudget();
        _clearPendingRemoteToken();
        _clearPendingBand();
        _clearPendingSigningGrant();
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
        _clearPendingPolicy(); // FP-CARRY-4: only the policy slot
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
        _clearPendingPolicy();
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
        _clearPendingTokenPolicy(); // FP-CARRY-4: only the token-policy slot
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
        _clearPendingTokenPolicy();
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
