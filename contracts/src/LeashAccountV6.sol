// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SigningLib} from "./SigningLib.sol";
import {DecodeLib} from "./DecodeLib.sol";
import {PolicyLib} from "./PolicyLib.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

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

/// @title LeashAccountV6 — the MULTI-ASSET governed account (AQ-FND M-1/M-2).
/// @notice A NEW immutable version (v2–v5 bytecode UNTOUCHED; parallel-deploy, no migration of
///         live accounts). V6 is the V5 governed-calldata + governed-signing wall VERBATIM,
///         with the AQ-FND custody substrate changes (AQ-FND-SPEC.md §2):
///
///         1. **Per-asset base model (M-1).** The immutable single `settlementToken` + the
///            native scalar caps + the governed `spendBudget` map are UNIFIED into ONE
///            `mapping(asset => AssetPolicy)` (asset(0) = native) with a per-asset payee
///            allowlist. All three money paths meter the SAME per-asset window, so the
///            account's blast radius is exactly Σ per-asset windowCaps (G-3, token units,
///            no oracle) and an `approve` debit (already charged by the governed decode)
///            lands on the same meter a transfer does — a window-exhausted asset cannot
///            approve (G-4; infinite approvals stay forbidden in DecodeLib).
///         2. **Sliding/two-bucket window (G-2).** V5's three tumbling counters carried a 2×
///            boundary burst; V6 replaces them with one O(1) two-bucket sliding counter
///            (`_debitAsset`) across native `execute`, `executeTokenTransfer`, AND the
///            governed-call/signing debit path. NET-NEW money-moving code — the riskiest
///            edit in the unit, suite-covered incl. the boundary double-spend.
///         3. **Cap-independence invariant (G-1).** Config-time NON-strict
///            `windowCap >= perTransferCap` on every asset-policy write (V5 had NO cross-cap
///            relation at all). `window == perTransfer` is ALLOWED (a deliberate
///            one-max-transfer-per-window envelope); only `window < perTransfer` rejects.
///         4. **The owner envelope + in-envelope agent self-extension (M-2, G-6, D-1=B+C+D).**
///            The owner pre-commits per-asset ceilings (the envelope) on the slow/timelocked
///            path; the agent (session key) may then ENABLE an envelope-covered asset
///            instantly with strict-subset caps — movement inside a pre-committed,
///            instantly-revocable envelope loosens nothing. A SHARP move (enable above
///            `sharpBps` of the ceiling, or a never-seen payee) queues behind an
///            owner-cancelable VETO window (`vetoDelay`) — a veto, not an approve, so the
///            common case never waits. Outside the envelope: refused on-chain
///            (`OutsideEnvelope`); the ask-once UX rides the off-chain escalation rail on
///            top of the `BudgetNotSet` floor. The agent can always TIGHTEN its own caps
///            instantly (attenuation law: narrow, never widen).
///         5. **Instant per-asset disable (G-7)** + every tighten instant; widen timelocked;
///            `timelockDelay` and `vetoDelay` are IMMUTABLE post-deploy (the Morpho rule's
///            stronger arm — the delay cannot be shortened at all, G-7's stated choice).
///
///         Inherited VERBATIM from V5: governed calldata (strict canonical decode,
///         (target,selector) rules — G-5, per-call caps, codehash pins, one-shots), governed
///         signing (ERC-1271 arm/disarm, descriptors, co-signer, signing epoch), oracle
///         price-band, bridge remote-token pins, chainid-bound callHash, revoke/rearm,
///         default-deny everywhere, no-delegatecall-by-construction.
contract LeashAccountV6 is ReentrancyGuard {
    // ---------- AQ-FND M-1/M-2 types: declared in PolicyLib (one layout by construction;
    // the SigningLib.SigningIntentPolicy pattern). AssetPolicy/WindowMeter/EnvelopeEntry/
    // SessionPolicy are referenced as PolicyLib.* throughout. ----------

    // ---------- Stage D — governed-calldata types (VERBATIM V5 shape) ----------
    // NOTE (G-2 scope): the per-rule window stays V5-tumbling — every charge on it is ALSO
    // debited against the asset's SLIDING window in the same call, so the boundary burst is
    // closed by the primary meter; the rule window is the narrower secondary bound.
    struct CallRule {
        bool allowed;
        uint8 recipientMode;
        uint128 perCallCap;
        uint128 windowCapCall;
        uint128 spentInWindowCall;
        uint64 windowStartCall;
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
    /// @dev FP-3 (C-02 reopened): `numFields` is the TOP-LEVEL member count; the role indices
    ///      (`spenderIndex`/`amountIndex`/`deadlineIndex`) are LEAF-space indices into the flat
    ///      leaf-word array the session key submits. For a FLAT descriptor (`nestedTypeHash==0`,
    ///      the FP-1 path) leaf space == top-level space and this struct behaves byte-identically
    ///      to FP-1. For a ONE-LEVEL-nested descriptor (Permit2 `PermitSingle`/`PermitTransferFrom`)
    ///      the submitter provides ALL leaves flat (nested leaves included) so the wall reads the
    ///      REAL nested `amount` as `leaves[amountIndex]` (cappable), and `nestedTypeHash` +
    ///      `nestedLeafStart` + `nestedLeafCount` describe the single contiguous sub-struct run the
    ///      wall folds back to reconstruct the protocol's true EIP-712 digest. `nestedLeafStart`
    ///      doubles as the nested member's TOP-LEVEL position (provably equal: every top member
    ///      before the group is a single leaf). `expiryLeafIndex` (0xFF ⇒ none) bounds a secondary
    ///      time field (Permit2 `expiration`) to the same `maxDeadlineWindow` so the on-chain
    ///      allowance lifetime cannot outlive the governed window (FP-3 review R-2).
    ///      NOTE (FP-3 review R-1): no separate amount-width check is needed — `perIntentCap` is
    ///      uint128, so any leaf word with a bit at position ≥128 exceeds the max possible cap and
    ///      reverts `OverPerIntentCap`; the deadline/expiry are likewise self-bounded by the uint64
    ///      `maxDeadlineWindow`. High-bit stuffing therefore fails closed at OUR invariant, not the
    ///      downstream protocol's.
    // `SigningIntentPolicy` moved to SigningLib (FP-4 Slice-2, D-FP4-2d) so the account can hand the whole
    // policy to `reconstructAndBound` in one call; field order is VERBATIM ⇒ identical storage layout.

    /// @notice An armed EIP-712 digest the pre-authorization accepted — the view
    ///         `isValidSignature` returns the magic value ONLY while armed + unexpired.
    struct ArmedIntent {
        bool set;
        uint64 expiry;
        uint64 epoch; // FP-CARRY-5: snapshot of signingEpoch at arm time; a tighten bumps the
            // live epoch so a stale arm is invalid in isValidSignature without a per-digest disarm.
    }

    /// @notice FP-4 Slice-4 — mirrors `SigningLib.KIND_ORDER`; a CoW order skips the spender allowlist (I-1).
    uint8 internal constant KIND_ORDER = 1;
    /// @notice FP-4 Slice-5 — mirrors `SigningLib.KIND_BATCH`; a Permit2 batch loops `_debitAsset` over
    ///         the distinct `(token, Σ)` pairs the lib returns (the one load-bearing account change, I-3).
    uint8 internal constant KIND_BATCH = 2;

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
    error TokenNotAllowlisted(address token); // asset not enabled on a simple-transfer path
    error TokenTransferFailed();
    // AQ-FND M-1/M-2
    error CommitMismatch(); // apply payload != proposed payload (hash-commit pending slot)
    error NotEnvelopeModule(); // module-gated writer called by anyone else
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
    error BadCoSignerSignature();
    error DeadlineInPast();
    error DeadlineTooFar(uint256 deadline);
    error AssetNotEighteenDecimals(uint8 got);
    error AlreadyArmed(); // FP-CARRY-5 (D-FP1-7): a still-live digest cannot be re-debited.
    error OverPerIntentCap(uint256 amount, uint128 cap); // distinct from the Stage-D calling-path cap.

    // ---------- events ----------
    event Executed(address indexed to, uint256 value, uint128 spentInWindow);
    event TokenExecuted(address indexed token, address indexed to, uint256 amount, uint128 spentInWindowToken);
    event CallExecuted(address indexed target, bytes4 indexed selector, uint256 chargeable, bool oneShot);
    event Revoked(address indexed by);
    event Rearmed(address indexed by);
    // AQ-FND M-1: per-asset grammar (asset(0) = native)
    event SessionPolicyChanged(PolicyLib.SessionPolicy p);
            event AssetPolicyChanged(address indexed asset, PolicyLib.AssetPolicy p);
    event AssetDisabled(address indexed asset);
        event AllowlistAdded(address indexed asset, address indexed to);
    event AllowlistRemoved(address indexed asset, address indexed to);
    // AQ-FND: ONE generic owner loosen pair (EIP-170); payload abi.encoded per kind
    // (1 asset / 3 session / 4 payee — the envelope lives on the EnvelopeModule).
    event GovernedProposed(uint8 indexed kind, bytes payload, uint64 eta);
    event WithdrawProposed(address indexed to, uint256 amount, uint64 eta);
    event WithdrawExecuted(address indexed to, uint256 amount);
    event SessionKeyChanged(address indexed oldKey, address indexed newKey);
    event GuardianChanged(address indexed oldGuardian, address indexed newGuardian);
    event CoSignerProposed(address indexed oldCoSigner, address indexed newCoSigner, uint64 eta);
    event CoSignerChanged(address indexed oldCoSigner, address indexed newCoSigner);
    event Deposited(address indexed from, uint256 amount);
    event CallRuleProposed(address indexed target, bytes4 indexed selector, uint64 eta);
    event CallRuleChanged(address indexed target, bytes4 indexed selector, uint128 perCallCap, uint128 windowCapCall);
    event CallRuleRemoved(address indexed target, bytes4 indexed selector);
    event CallTargetRemoved(address indexed target);
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
    /// @dev FP-3 (EIP-170): the deployed stateless pure helper singletons (signing fold + grant
    ///      validation; governed-call decode). Called via STATICCALL (C-03 no-delegatecall preserved).
    ///      Immutable — set once at construction, never swappable.
    address public immutable signingHelper;
    address public immutable decodeHelper;
    address public immutable policyHelper; // AQ-FND: the V6 pure policy singleton (STATICCALL)
    address public guardian;
    address public sessionKey;
    bool public revoked;

    // ---------- AQ-FND M-1 state: the per-asset base model (asset(0) = native) ----------
    PolicyLib.SessionPolicy public session;
    mapping(address => PolicyLib.AssetPolicy) public assetPolicy;
    /// @notice AQ-FND Lane-B observability: public so the backend PolicyView can read the
    ///         raw two-bucket meter (cur, prev, start) and mirror PolicyLib.slide off-chain
    ///         — enforcement stays on-chain; the getter only makes the state observable.
    mapping(address => PolicyLib.WindowMeter) public assetMeter;
    /// @notice Per-asset payee allowlist (G-5's sibling on the simple paths): (asset, payee).
    mapping(address => mapping(address => bool)) public allowlist;
    /// @notice A payee ever allowlisted on ANY asset — the M-2 "never-seen counterparty" test
    ///         (public: the EnvelopeModule reads it to route instant-vs-veto).
    mapping(address => bool) public knownPayee;

    // ---------- AQ-FND M-2: the envelope + agent self-extension live on the IMMUTABLE
    // EnvelopeModule singleton (EIP-170 split; see LeashEnvelopeModuleV6 — the audited
    // Safe-Allowance-Module shape). Its ONLY reach into the account is the two `module*`
    // writers below, which re-validate G-1 and refuse when revoked. ----------
    address public immutable envelopeModule;

    uint64 public immutable timelockDelay;

    // AQ-FND (EIP-170): ONE governed pending slot for every owner LOOSEN (asset / envelope /
    // session / payee). Stores only (kind, commit, eta); apply re-submits the payload and
    // verifies the commit — the payload itself rides the GovernedProposed event. A tighten
    // clears the slot only when it targets the SAME kind (FP-CARRY-4 granularity).
    uint8 public pendingGovernedKind;
    bytes32 internal pendingGovernedCommit;
    uint64 public pendingGovernedEta;
    address public pendingWithdrawTo;
    uint256 public pendingWithdrawAmount;
    uint64 public pendingWithdrawEta;

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

    address public pendingRemoteLocalToken;
    address public pendingRemoteTokenValue;
    uint64 public pendingRemoteTokenEta;

    // ---------- Stage F′ state: governed signing ----------
    bytes4 internal constant ERC1271_MAGIC = 0x1626ba7e; // bytes4(keccak256("isValidSignature(bytes32,bytes)"))
    bytes4 internal constant ERC1271_INVALID = 0xffffffff;

    // FP-4 Slice-5 (EIP-170 reclaim): internal, not public. The auto-getter (unused by any test or the
    // off-chain read-model, which is event-driven) cost ~0.5KB of return-tuple encoding; reclaiming it is
    // what lets the batch arm fit under 24,576. On-chain reads are internal.
    mapping(uint256 => SigningLib.SigningIntentPolicy) internal signingIntentPolicy; // descriptorId => policy
    mapping(uint256 => mapping(address => bool)) public signingSpender; // descriptorId => spender => allowed
    mapping(uint256 => address[]) internal signingSpenderList; // descriptorId => spenders (so a re-grant/remove clears cleanly)
    mapping(bytes32 => ArmedIntent) public armedIntent; // eip712 digest => armed

    /// @notice FP-CARRY-5 (D-FP1-7): the monotonic signing epoch. Every armed intent snapshots
    ///         it; `isValidSignature` requires the snapshot == the current value. Any
    ///         signing-relevant TIGHTEN (tightenSigningGrant / removeSigningDescriptor /
    ///         tightenAssetPolicy/disableAsset) and `revoke` advance it, so one owner tighten invalidates
    ///         ALL in-flight armed intents fail-safe — the owner never needs each digest.
    ///         Deliberately global (any tighten kills every stale arm); re-arm re-authorizes
    ///         under the new (tightened) policy.
    uint64 public signingEpoch;

    /// @notice Co-signer second factor (FP-4 Slice-2, `07 #15`). `coSigner == address(0)` ⇒ the hook
    ///         is INERT (one-factor, session-key-only). When set, every `authorizeSigningIntent` arm
    ///         requires the co-signer's approval over `CoSignerApproval(intentDigest,chainId,account,epoch)`
    ///         as a second factor (SigningLib.verifyCoSigner). Real cross-chain value stays gated by `07 #16`;
    ///         the co-signer IDENTITY + timelock duration are ratified at the mainnet-legal gate (D-FP4-2e).
    address public coSigner;

    /// @notice Pending co-signer WEAKENING (remove `X→0` or swap `X→Y≠X`) — timelocked (D-FP4-2c). Those
    ///         are the loosen-in-disguise moves a compromised owner would use to defeat the factor, so they
    ///         wait out `timelockDelay`, giving the real owner a window to `revoke`. ADDING the factor
    ///         (`address(0)→X`) is an instant tighten (no pending slot). `eta == 0` ⇒ nothing pending.
    address public pendingCoSigner;
    uint64 public pendingCoSignerEta;

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
        // --- FP-3 one-level nested fold (mirrors SigningIntentPolicy) ---
        bytes32 nestedTypeHash;
        uint8 nestedLeafStart;
        uint8 nestedLeafCount;
        uint8 expiryLeafIndex;
        // --- FP-4 Slice-4 (CoW order; mirrors SigningIntentPolicy) ---
        uint8 kind; // KIND_STANDARD (0) / KIND_ORDER (1) / KIND_BATCH (2)
        address buyToken; // KIND_ORDER only — wall-pinned proceeds token (G11(b)); 0 for standard
        // --- FP-4 Slice-5 — the committed hash of the reviewed per-token cap allowlist (caps-hash commit,
        //     Dami 2026-10-08; KIND_BATCH only, 0 otherwise). A word, not an array (EIP-170, §10). ---
        bytes32 tokenCapsHash;
    }

    // FP-4 Slice-5 (EIP-170 reclaim): internal — see signingIntentPolicy note (unused auto-getter).
    PendingSigningGrant internal pendingSigningGrant;
    address[] internal pendingSigningSpenders;

    modifier onlyOwner() {
        _onlyOwner();
        _;
    }

    /// @dev Modifier logic wrapped into a function so the owner-gate is a single CALL at each of its
    ///      ~36 use-sites instead of inlined everywhere — a behavior-identical EIP-170 size reduction
    ///      (the solc `unwrapped-modifier-logic` hint; FP-3 brought the account under the 24KB limit).
    function _onlyOwner() internal view {
        if (msg.sender != owner) revert NotOwner();
    }

    /// @dev The session-key hot-path preamble (EIP-170: one CALL at each money/agent site).
    function _onlyLiveSession() internal view {
        if (msg.sender != sessionKey) revert NotSessionKey();
        if (revoked) revert AccountRevoked();
        if (block.timestamp > session.expiresAt) revert SessionExpired();
    }

    /// @notice Construction config (one struct — the V5 arg list outgrew stack depth with the
    ///         multi-asset fields). `initialAssets[i]` pairs with `initialAssetPolicies[i]`;
    ///         asset(0) (native) is configured by `nativePolicy`. `initialAllowlist` payees are
    ///         seeded on NATIVE and on every initial asset (owner-set at birth = owner-committed).
    ///         `envAssets[i]`/`envEntries[i]` seed the owner envelope (birth = the slow path:
    ///         the owner signs the whole construction tuple).
    struct InitConfig {
        address owner;
        address guardian;
        address sessionKey;
        PolicyLib.SessionPolicy session;
        PolicyLib.AssetPolicy nativePolicy;
        address[] initialAssets;
        PolicyLib.AssetPolicy[] initialAssetPolicies;
        address[] initialAllowlist;
        uint64 timelockDelay;
        address signingHelper;
        address decodeHelper;
        address policyHelper;
        address envelopeModule;
    }

    constructor(InitConfig memory c) {
        if (c.owner == address(0) || c.sessionKey == address(0)) revert ZeroAddress();
        if (c.signingHelper == address(0) || c.decodeHelper == address(0) || c.policyHelper == address(0)) {
            revert ZeroAddress();
        }
        if (c.session.ruleWindowSeconds == 0) revert InvalidPolicy();
        if (c.initialAssets.length != c.initialAssetPolicies.length) revert InvalidPolicy();
        if (c.envelopeModule == address(0)) revert ZeroAddress();
        signingHelper = c.signingHelper;
        decodeHelper = c.decodeHelper;
        policyHelper = c.policyHelper;
        owner = c.owner;
        guardian = c.guardian;
        sessionKey = c.sessionKey;
        session = c.session;
        timelockDelay = c.timelockDelay;
        envelopeModule = c.envelopeModule;
        _setAssetPolicy(address(0), c.nativePolicy); // G-1 invariant enforced inside
        for (uint256 i = 0; i < c.initialAssets.length; i++) {
            if (c.initialAssets[i] == address(0)) revert ZeroAddress();
            _setAssetPolicy(c.initialAssets[i], c.initialAssetPolicies[i]);
        }
        for (uint256 i = 0; i < c.initialAllowlist.length; i++) {
            address payee = c.initialAllowlist[i];
            if (payee == address(0)) revert ZeroAddress();
            _addPayee(address(0), payee);
            for (uint256 j = 0; j < c.initialAssets.length; j++) {
                _addPayee(c.initialAssets[j], payee);
            }
        }
    }

    /// @dev The ONE asset-policy write path (constructor + owner grammar + agent enable all
    ///      route here) — G-1 lives in exactly one place. NON-strict: `window == perTransfer`
    ///      is allowed; only `window < perTransfer` reverts. A write (re-)enables the asset
    ///      and resets its meter start if unset.
    function _setAssetPolicy(address asset, PolicyLib.AssetPolicy memory p) internal {
        PolicyLib(policyHelper).validateAsset(p); // G-1 lives in exactly one place
        p.enabled = true;
        assetPolicy[asset] = p;
        if (assetMeter[asset].start == 0) assetMeter[asset].start = uint64(block.timestamp);
        emit AssetPolicyChanged(asset, p);
    }

    function _addPayee(address asset, address payee) internal {
        allowlist[asset][payee] = true;
        knownPayee[payee] = true;
        emit AllowlistAdded(asset, payee);
    }

    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    // ================= AQ-FND M-1: the simple spend paths (per-asset, sliding) =================

    function execute(address to, uint256 value, bytes calldata data) external nonReentrant {
        _onlyLiveSession();
        if (to == address(0)) revert ZeroAddress();
        if (!allowlist[address(0)][to]) revert NotAllowlisted(to);
        if (data.length != 0) revert CalldataForbidden();
        PolicyLib.AssetPolicy storage p = assetPolicy[address(0)];
        if (!p.enabled) revert TokenNotAllowlisted(address(0));
        if (value > p.perTransferCap) revert OverPerTransferCap(value, p.perTransferCap);

        uint128 est = _debitAsset(address(0), value);
        emit Executed(to, value, est);

        (bool ok,) = to.call{value: value}("");
        if (!ok) revert CallFailed();
    }

    function executeTokenTransfer(address token, address to, uint256 amount) external nonReentrant {
        _onlyLiveSession();
        if (to == address(0) || token == address(0)) revert ZeroAddress();
        PolicyLib.AssetPolicy storage p = assetPolicy[token];
        if (!p.enabled) revert TokenNotAllowlisted(token); // the D-1 hold-vs-spend floor: a
            // held-but-ungoverned (novel) token cannot move until a policy exists for it.
        if (!allowlist[token][to]) revert NotAllowlisted(to);
        if (amount > p.perTransferCap) revert OverPerTransferCap(amount, p.perTransferCap);

        uint128 est = _debitAsset(token, amount);
        emit TokenExecuted(token, to, amount, est);

        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TokenTransferFailed();
    }

    /// @dev AQ-FND G-2: THE per-asset debit — the ONE window meter all three money paths share
    ///      (native `execute`, `executeTokenTransfer`, the governed-call/signing `chargeable`).
    ///      Sliding two-bucket counter: the estimate `cur + prev·(W−offset)/W` decays the
    ///      previous bucket linearly, so the full-cap-at-the-edge-then-again burst that a
    ///      tumbling reset allows (2× cap) is refused — at the boundary the carried estimate
    ///      is still ≈ the whole previous spend. O(1) storage (two uint128 + one uint64).
    ///      Reverts `BudgetNotSet` for a disabled/never-governed asset (the on-chain floor the
    ///      M-2 hold-vs-spend ask rides on) and `OverWindowCap` past the cap. Returns the new
    ///      estimate for events.
    function _debitAsset(address asset, uint256 amount) internal returns (uint128) {
        PolicyLib.AssetPolicy storage p = assetPolicy[asset];
        if (!p.enabled) revert BudgetNotSet(asset);
        PolicyLib.WindowMeter storage m = assetMeter[asset];
        (uint128 cur, uint128 prev, uint64 start, uint128 estimate) =
            PolicyLib(policyHelper).slide(m, p.windowSeconds, amount, p.windowCap);
        m.cur = cur;
        m.prev = prev;
        m.start = start;
        return estimate;
    }

    // ================= Stage D — governed calldata =================

    function executeCall(address target, uint256 value, bytes calldata data) external nonReentrant {
        _onlyLiveSession();
        if (target == address(this)) revert SelfCallForbidden();
        if (target == address(0)) revert ZeroAddress();
        if (data.length < 4) revert DecodeMismatch();
        if (target.code.length == 0) revert EmptyCodeTarget(target);

        bytes4 selector = bytes4(data[0:4]);
        bytes32 callHash = keccak256(abi.encode(block.chainid, target, selector, data, value));

        uint64 osEta = oneShotAuthEta[callHash];
        if (osEta != 0) {
            if (block.timestamp > osEta) revert OneShotExpired();
            if (DecodeLib(decodeHelper).isBridgeSelector(selector)) {
                // one-shot bridge pre-check: re-run the pure bridge decode + the storage remote-token
                // pin check (the former `_checkBridgeArgs` side-effect), now split across DecodeLib.
                DecodeLib.Decoded memory bd =
                    DecodeLib(decodeHelper).decodeStructuredArgs(selector, value, data, address(this), 0, target);
                if (bd.bridgeLocalToken != address(0)) {
                    address pinned = bridgeRemoteToken[bd.bridgeLocalToken];
                    if (pinned == address(0)) revert RemoteTokenNotPinned(bd.bridgeLocalToken);
                    if (bd.bridgeRemoteClaim != pinned) revert RemoteTokenMismatch(pinned, bd.bridgeRemoteClaim);
                }
            }
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
        _enforceAndExecute(target, selector, value, data);
    }

    function _enforceAndExecute(
        address target,
        bytes4 selector,
        uint256 value,
        bytes calldata data
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
            _debitAsset(spendToken, chargeable); // the SAME per-asset meter the simple paths use
        }
        _debitCallWindow(ruleKey, chargeable);

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

    /// @dev Thin wrapper over the pure `DecodeLib.decodeStructuredArgs` (FP-3 EIP-170 extraction):
    ///      the library does all shape/`==self`/arithmetic decode + reverts; the account performs the
    ///      STORAGE policy checks the decode cannot (spender allowlist, recipient allowlist, bridge
    ///      remote-token pin) on the returned values. Behaviour byte-identical to the former inlined
    ///      decode — the full governed-call suite re-verifies it.
    function _checkStructuredArgs(
        address target,
        bytes4 selector,
        uint256 value,
        bytes calldata data,
        bytes32 ruleKey,
        CallRule memory rule
    ) internal view returns (uint256 chargeable, address spendToken, bool checkBoolReturn) {
        DecodeLib.Decoded memory dd =
            DecodeLib(decodeHelper).decodeStructuredArgs(selector, value, data, address(this), rule.recipientMode, target);
        if (dd.spenderToAllow != address(0) && !callRuleSpender[ruleKey][dd.spenderToAllow]) {
            revert SpenderNotAllowlisted(dd.spenderToAllow);
        }
        // AQ-FND M-1: the recipient allowlist is PER-ASSET — keyed on the asset this call spends
        // (`dd.spendToken`; address(0) = native for plain-value calls).
        if (dd.recipientToAllowlist != address(0) && !allowlist[dd.spendToken][dd.recipientToAllowlist]) {
            revert NotAllowlisted(dd.recipientToAllowlist);
        }
        if (dd.bridgeLocalToken != address(0)) {
            address pinned = bridgeRemoteToken[dd.bridgeLocalToken];
            if (pinned == address(0)) revert RemoteTokenNotPinned(dd.bridgeLocalToken);
            if (dd.bridgeRemoteClaim != pinned) revert RemoteTokenMismatch(pinned, dd.bridgeRemoteClaim);
        }
        return (dd.chargeable, dd.spendToken, dd.checkBoolReturn);
    }

    function _isBoolReturningSelector(bytes4 selector) internal pure returns (bool) {
        return selector == SEL_APPROVE || selector == SEL_INCREASE_ALLOWANCE || selector == SEL_TRANSFER
            || selector == SEL_TRANSFER_FROM;
    }

    /// @dev The band storage read + `set` early-return stay here; the decode + oracle math are in the
    ///      stateless `DecodeLib` helper (STATICCALL — FP-3 EIP-170 extraction; C-03 preserved).
    function _checkPriceBand(bytes32 ruleKey, bytes4 selector, bytes calldata data) internal view {
        PriceBandPolicy storage band = priceBand[ruleKey]; // storage pointer (EIP-170: no memory copy)
        if (!band.set) return;
        DecodeLib(decodeHelper).checkPriceBand(band.feed, band.asset, band.maxDeviationBps, band.maxStaleness, selector, data);
    }

    function _decodeAddress(bytes calldata data, uint256 offset) internal pure returns (address) {
        bytes32 word = bytes32(data[offset:offset + 32]);
        if (uint256(word) >> 160 != 0) revert DecodeMismatch();
        return address(uint160(uint256(word)));
    }

    function _decodeUint(bytes calldata data, uint256 offset) internal pure returns (uint256) {
        return uint256(bytes32(data[offset:offset + 32]));
    }

    function _debitCallWindow(bytes32 ruleKey, uint256 amount) internal {
        CallRule storage r = callRules[ruleKey];
        if (block.timestamp >= uint256(r.windowStartCall) + session.ruleWindowSeconds) {
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
        ArmedIntent storage a = armedIntent[hash]; // storage pointer (EIP-170: no memory copy)
        // FP-CARRY-5: a stale-epoch arm (invalidated by an owner tighten) is INVALID.
        if (a.set && a.epoch == signingEpoch && block.timestamp <= a.expiry) return ERC1271_MAGIC;
        return ERC1271_INVALID;
    }

    /// @dev FP-CARRY-5 (D-FP1-7): advance the signing epoch — every in-flight armed intent
    ///      snapshotting the old value becomes INVALID in `isValidSignature`. Called by every
    ///      signing-relevant tighten/removal + `revoke` (fail-safe, global).
    function _bumpSigningEpoch() internal {
        unchecked {
            signingEpoch++;
        }
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
    ///         without its own nonce is OUT OF SCOPE and must not be registered. The FP-2
    ///         engine CODE-ENFORCES this replay guard at descriptor-review time
    ///         (`assertDescriptor`, F′-SIGN-1): a flat/nested descriptor MUST declare a
    ///         `nonceRole` resolving to a distinct uintN nonce LEAF (ERC-2612 `nonce`,
    ///         Permit2 nested `nonce`); a `batch` descriptor structurally requires its
    ///         `nonce` top field; an `order` is exempt because GPv2Settlement tracks the
    ///         nonce externally to the descriptor. A nonce-less flat/nested permit therefore
    ///         cannot be registered. `amount == 0` arms a
    ///         zero-notional intent (e.g. a cancel/zero-approval) and skips the budget debit
    ///         by design — it moves no value. The owner can `disarmSigningIntent` a single
    ///         armed digest, or `revoke` to fail-close all. M-01 (accepted): an armed permit
    ///         inherits the project's <=2x-cap-across-a-window-boundary burst bound, exactly
    ///         as the calling path does (`00`/LIMITATIONS); bound by the per-window budget.
    function authorizeSigningIntent(
        uint256 descriptorId,
        bytes32[] calldata fields,
        SigningLib.TokenCap[] calldata caps,
        bytes calldata sessionSig,
        bytes calldata coSignerSig
    ) external nonReentrant returns (bytes32 digest) {
        _onlyLiveSession();

        SigningLib.SigningIntentPolicy memory s = signingIntentPolicy[descriptorId];
        if (!s.set) revert DescriptorNotRegistered(descriptorId); // default-deny

        // strict-canonical binding + BOTH signature factors + decode + bounds, in ONE SigningLib call
        // (D-FP4-2d, EIP-170 — the account carries NO ECDSA codegen): the digest is reconstructed from the
        // submitted leaf words (FLAT nestedTypeHash==0 = FP-1 path, byte-identical; NESTED folds one
        // contiguous sub-struct run into a single top-level member so the digest equals the real protocol's
        // — Permit2); factor 1 = the session key signed this digest (`BadIntentSignature`); factor 2 = the
        // co-signer second factor enforced UNCONDITIONALLY when `coSigner != 0` (SR-4), binding chainId +
        // this account + signingEpoch (SR-1/SR-3, `BadCoSignerSignature`); spender/amount/deadline(/expiry)
        // are canonical-decoded + cap/deadline-bounded — all BEFORE any state write (fail-closed, SR-11).
        // The spender-ALLOWLIST check + the re-arm idempotency guard stay here (storage).
        address spender;
        uint256 deadline;
        // FP-4 Slice-5 — ONE lib call for ALL kinds (EIP-170 lever, §10): SigningLib delivers the arm's debit
        // as an interleaved `(token-as-uint, Σ)[]` — for standard/order ONE pair (empty when amount==0); for
        // batch the per-token Σ vectors. `caps` is the session-key-submitted reviewed allowlist, verified by
        // the lib against the committed `s.tokenCapsHash` (caps-hash commit); it is empty for non-batch arms.
        uint256[] memory debits;
        (digest, spender, debits, deadline) = SigningLib(signingHelper).reconstructAndBound(
            s, caps, fields, block.timestamp, block.chainid, address(this), signingEpoch, coSigner, coSignerSig, sessionSig, sessionKey
        );

        // FP-CARRY-5 (D-FP1-7) re-arm idempotency: a STILL-LIVE armed digest cannot be
        // re-debited (double-charging the shared budget for one authorization). A stale
        // (epoch-invalidated) or expired entry MAY be overwritten — it is re-authorized under
        // current policy. An expired same-fields digest is already blocked below by the
        // deadline check (same fields ⇒ same deadline).
        ArmedIntent storage existing = armedIntent[digest]; // storage pointer (EIP-170: no memory copy)
        if (existing.set && existing.epoch == signingEpoch && block.timestamp <= existing.expiry) revert AlreadyArmed();

        // FP-4 Slice-4 (I-1): a CoW order has NO spender (`spenderIndex==0xFF`, `spender==address(0)`) — the
        // mover is GPv2VaultRelayer, governed OFF the order via the `approve` CALL surface. Skip the allowlist
        // for order; every other kind keeps the mandatory spender-allowlist check. The order's outflow is still
        // hard-bounded (sellToken==s.token, receiver==self, cap on sellAmount+feeAmount) inside reconstructAndBound.
        if (s.kind != KIND_ORDER && !signingSpender[descriptorId][spender]) revert SpenderNotAllowlisted(spender);

        // signing ≤ calling: debit the SAME per-token budget the executeCall wall uses. ONE loop serves every
        // kind (FP-4 Slice-5, I-3 the load-bearing account change): standard/order deliver a single
        // `(s.token, amount)` pair — amount already carries order's sellAmount+feeAmount (I-2) — and an EMPTY
        // vector when amount==0 (zero-notional arm, no debit); batch delivers each distinct `(token, Σ)` pair.
        // `_debitAsset` keys on token and reverts `BudgetNotSet` for any token the owner never funded
        // (correct fail-closed — a batch can move only tokens with BOTH a reviewed cap AND a funded budget).
        uint256 amount; // total notional debited across tokens (the arm event's amount field)
        for (uint256 i = 0; i < debits.length; i += 2) {
            _debitAsset(address(uint160(debits[i])), debits[i + 1]); // signing ≤ calling: same meter
            amount += debits[i + 1];
        }

        armedIntent[digest] = ArmedIntent({set: true, expiry: uint64(deadline), epoch: signingEpoch});
        emit SigningIntentAuthorized(descriptorId, digest, spender, amount, uint64(deadline));
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
    /// @notice FP-3 (C-02 reopened): onboard a ONE-LEVEL-nested protocol (Permit2
    ///         `PermitSingle`/`PermitTransferFrom`). Same LOOSENING→timelocked grant as the flat
    ///         path; the fold spec lets the wall reconstruct the real protocol digest while reading
    ///         the nested `amount` as a leaf (so `perIntentCap` + the budget debit still bind it).
    ///         Validated in-contract (NOT engine-only) — the owner tx is the sole authority.
    /// @notice FP-4 Slice-5 — the optional `caps` arg carries the reviewed per-token cap allowlist for a
    ///         KIND_BATCH grant (empty for standard/order). The account validates it (`validateBatchCaps`
    ///         reverts on empty/zero-cap/dup) and commits only `keccak256(abi.encode(caps))` to the policy
    ///         (caps-hash commit, EIP-170). No new external selector beyond the added arg (§4.6).
    function proposeSigningGrantNested(
        SigningLib.SigningGrantParams calldata p,
        address[] calldata spenders,
        SigningLib.TokenCap[] calldata caps
    ) external onlyOwner {
        _stageSigningGrant(p, spenders, caps);
    }

    /// @dev Shared validate-and-stage for both flat and nested signing grants. Validation is the pure
    ///      `SigningLib.validateGrant` (FP-3 review R-3; it REVERTS internally on any defect — called
    ///      unconditionally BEFORE the write, never in a try/catch, so an invalid grant can never be
    ///      stored). The storage write stays in the account.
    function _stageSigningGrant(
        SigningLib.SigningGrantParams memory p,
        address[] calldata spenders,
        SigningLib.TokenCap[] calldata caps
    ) internal {
        // FP-4 Slice-5 — ONE lib call validates the grant AND (for batch) validates+hashes the caps allowlist,
        // returning the commitment the account stores (caps-hash commit). Reverts InvalidPolicy/ZeroAddress on
        // any defect — fail-closed, unconditional, no try/catch (FP-3 review R-3).
        (, bytes32 capsHash) = SigningLib(signingHelper).validateGrant(p, caps);

        // Direct storage-field writes (not a memory struct literal copied to storage) — the same EIP-170
        // lever as the storage-pointer read in `applySigningGrant`; avoids building the 16-field struct in memory.
        PendingSigningGrant storage pg = pendingSigningGrant;
        pg.descriptorId = p.descriptorId;
        pg.domainSeparator = p.domainSeparator;
        pg.typeHash = p.typeHash;
        pg.numFields = p.numTopFields;
        pg.spenderIndex = p.spenderLeafIndex;
        pg.amountIndex = p.amountLeafIndex;
        pg.deadlineIndex = p.deadlineLeafIndex;
        pg.token = p.token;
        pg.perIntentCap = p.perIntentCap;
        pg.maxDeadlineWindow = p.maxDeadlineWindow;
        pg.eta = uint64(block.timestamp) + timelockDelay;
        pg.nestedTypeHash = p.nestedTypeHash;
        pg.nestedLeafStart = p.nestedLeafStart;
        pg.nestedLeafCount = p.nestedLeafCount;
        pg.expiryLeafIndex = p.expiryLeafIndex;
        pg.kind = p.kind;
        pg.buyToken = p.buyToken;
        // FP-4 Slice-5 (caps-hash commit) — stage ONLY the caps commitment hash `validateGrant` returned (0
        // for non-batch). Just a word, no on-chain array (EIP-170, §10).
        pg.tokenCapsHash = capsHash;
        delete pendingSigningSpenders;
        for (uint256 i = 0; i < spenders.length; i++) {
            if (spenders[i] == address(0)) revert ZeroAddress();
            pendingSigningSpenders.push(spenders[i]);
        }
        emit SigningGrantProposed(p.descriptorId, pendingSigningGrant.eta);
    }

    function applySigningGrant() external onlyOwner {
        // Storage pointer (not a memory copy): avoids codegen for a full 16-field struct copy — the
        // EIP-170 lever Slice-2 used (D-FP4-2f). Each field below is read via a direct SLOAD.
        PendingSigningGrant storage pg = pendingSigningGrant;
        if (pg.eta == 0) revert NothingPending();
        if (block.timestamp < pg.eta) revert TimelockNotElapsed(pg.eta);
        // clear any prior spender set for this descriptor (a re-grant replaces it).
        _clearSigningSpenders(pg.descriptorId);
        SigningLib.SigningIntentPolicy storage s = signingIntentPolicy[pg.descriptorId];
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
        s.nestedTypeHash = pg.nestedTypeHash;
        s.nestedLeafStart = pg.nestedLeafStart;
        s.nestedLeafCount = pg.nestedLeafCount;
        s.expiryLeafIndex = pg.expiryLeafIndex;
        s.kind = pg.kind;
        s.buyToken = pg.buyToken;
        // FP-4 Slice-5 (caps-hash commit) — apply ONLY the committed caps hash (a re-grant REPLACES it;
        // batch-only, 0 otherwise). One word — the per-arm policy memory copy gains nothing but this word.
        s.tokenCapsHash = pg.tokenCapsHash;
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
        SigningLib.SigningIntentPolicy storage s = signingIntentPolicy[descriptorId];
        if (!s.set) revert DescriptorNotRegistered(descriptorId);
        if (perIntentCap > s.perIntentCap || maxDeadlineWindow > s.maxDeadlineWindow) revert NotTightening();
        s.perIntentCap = perIntentCap;
        s.maxDeadlineWindow = maxDeadlineWindow;
        _bumpSigningEpoch(); // FP-CARRY-5: invalidate in-flight arms under the old (looser) caps.
        _clearPendingSigningGrant();
        emit SigningGrantChanged(descriptorId, s.token, perIntentCap);
    }

    /// @notice Remove a descriptor entirely (default-deny again) — TIGHTENING → INSTANT.
    ///         Clears the spender set + ONLY the pending signing-grant slot (FP-CARRY-4).
    function removeSigningDescriptor(uint256 descriptorId) external onlyOwner {
        _clearSigningSpenders(descriptorId);
        delete signingIntentPolicy[descriptorId];
        _bumpSigningEpoch(); // FP-CARRY-5: default-deny again ⇒ kill every in-flight arm.
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

    // ========== AQ-FND M-1/M-2: per-asset grammar (the spine, generalized) ==========
    // Loosen/add = ONE timelocked generic propose→apply pair (EIP-170); tighten/disable =
    // dedicated INSTANT paths. `_setAssetPolicy` carries G-1 for owner, agent, constructor alike.

    function proposeGoverned(uint8 kind, bytes calldata payload) external onlyOwner {
        PolicyLib(policyHelper).validatePayload(kind, payload); // fail early (incl. G-1)
        pendingGovernedKind = kind;
        pendingGovernedCommit = keccak256(abi.encode(kind, payload));
        pendingGovernedEta = uint64(block.timestamp) + timelockDelay;
        emit GovernedProposed(kind, payload, pendingGovernedEta);
    }

    function applyGoverned(uint8 kind, bytes calldata payload) external onlyOwner {
        uint64 eta = pendingGovernedEta;
        if (eta == 0) revert NothingPending();
        if (block.timestamp < eta) revert TimelockNotElapsed(eta);
        if (keccak256(abi.encode(kind, payload)) != pendingGovernedCommit) revert CommitMismatch();
        if (kind == 1) {
            (address asset, PolicyLib.AssetPolicy memory p) = abi.decode(payload, (address, PolicyLib.AssetPolicy));
            _setAssetPolicy(asset, p);
        } else if (kind == 3) {
            PolicyLib.SessionPolicy memory sp = abi.decode(payload, (PolicyLib.SessionPolicy));
            session = sp;
            emit SessionPolicyChanged(sp);
        } else if (kind == 4) {
            (address asset, address payee) = abi.decode(payload, (address, address));
            _addPayee(asset, payee);
        } else {
            // Gate-② W-1: kind 2 (envelope) is MODULE-owned; any unknown kind must never
            // fall through to a wrong-type abi.decode (a silent allowlist corruption).
            revert InvalidPolicy();
        }
        _clearPendingGoverned();
    }

    /// @notice Lower an asset's caps — TIGHTENING → INSTANT. Owner OR session key (a tighten
    ///         only ever narrows, so the agent self-attenuates through the same path — M-2
    ///         attenuation law). FP-CARRY-4: clears only a SAME-KIND pending loosen.
    function tightenAssetPolicy(address asset, PolicyLib.AssetPolicy calldata p) external {
        if (msg.sender != owner && msg.sender != sessionKey) revert NotOwner();
        PolicyLib.AssetPolicy storage cur = assetPolicy[asset];
        if (!cur.enabled) revert BudgetNotSet(asset);
        PolicyLib(policyHelper).assertTighterAsset(p, cur);
        _setAssetPolicy(asset, p);
        _bumpSigningEpoch(); // the asset window is shared with signing (FP-CARRY-5)
        _clearGovernedIf(1);
    }

    /// @notice Instant per-asset kill (G-7) — owner OR guardian (same authority class as revoke;
    ///         a disable only ever narrows). Re-enabling is a loosen → propose path.
    function disableAsset(address asset) external {
        if (msg.sender != owner && msg.sender != guardian) revert NotGuardianOrOwner();
        assetPolicy[asset].enabled = false;
        _bumpSigningEpoch(); // in-flight armed intents on this asset die (fail-closed)
        _clearGovernedIf(1);
        emit AssetDisabled(asset);
    }

    // ---------- M-2: the EnvelopeModule's two gated writers (its ONLY reach) ----------

    /// @notice Set an asset policy on behalf of an in-envelope agent move. ONLY the immutable
    ///         EnvelopeModule may call; G-1 re-validates in `_setAssetPolicy`; refused when
    ///         revoked (the D backstop beats the module).
    function moduleSetAssetPolicy(address asset, PolicyLib.AssetPolicy calldata p) external {
        if (msg.sender != envelopeModule) revert NotEnvelopeModule();
        if (revoked) revert AccountRevoked();
        _setAssetPolicy(asset, p);
    }

    /// @notice Add a payee on behalf of an in-envelope agent move. Same gate; the asset must
    ///         already be enabled (no payees on ungoverned assets).
    function moduleAddPayee(address asset, address payee) external {
        if (msg.sender != envelopeModule) revert NotEnvelopeModule();
        if (revoked) revert AccountRevoked();
        if (payee == address(0)) revert ZeroAddress();
        if (!assetPolicy[asset].enabled) revert BudgetNotSet(asset);
        _addPayee(asset, payee);
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

    function _clearPendingGoverned() internal {
        pendingGovernedKind = 0;
        pendingGovernedCommit = 0;
        pendingGovernedEta = 0;
    }

    /// @dev FP-CARRY-4: a tighten clears the shared governed slot ONLY when the pending
    ///      loosen is the same kind (never a sibling dimension's deliberate pending loosening).
    function _clearGovernedIf(uint8 kind) internal {
        if (pendingGovernedKind == kind) _clearPendingGoverned();
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

    function _clearPendingSigningGrant() internal {
        delete pendingSigningGrant;
        delete pendingSigningSpenders;
    }

    /// @dev The full nuke — used ONLY by `revoke` (emergency, fail-closed). Every
    ///      instant tighten now clears ONLY its own slot (FP-CARRY-4); revoke clears ALL.
    function _clearPendingTimelocks() internal {
        _clearPendingGoverned();
        pendingWithdrawTo = address(0);
        pendingWithdrawAmount = 0;
        pendingWithdrawEta = 0;
        _clearPendingCallRule();
        _clearPendingRemoteToken();
        _clearPendingBand();
        _clearPendingSigningGrant();
        _clearPendingCoSigner(); // a tighten/revoke cancels a pending co-signer weakening (FP-CARRY-4).
    }

    function revoke() external {
        if (msg.sender != owner && msg.sender != guardian) revert NotGuardianOrOwner();
        revoked = true;
        _bumpSigningEpoch(); // FP-CARRY-5: a later rearm must NOT silently resurrect stale arms.
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
        // FP-3 Gate-② (security M-01): a session-key rotation MUST invalidate every in-flight armed
        // signing intent from the old key — else a pre-armed (un-expired) digest stays valid in
        // `isValidSignature` after the owner rotates away an exfiltrated key. Bump the signing epoch
        // (like every other signing-relevant state change); legitimate in-flight intents re-arm.
        _bumpSigningEpoch();
    }

    function setGuardian(address g) external onlyOwner {
        emit GuardianChanged(guardian, g);
        guardian = g;
    }

    /// @notice Set / change / remove the co-signer second factor (FP-4 Slice-2, D-FP4-2c). ASYMMETRIC:
    ///         - ADD (`coSigner == address(0)`, `next != address(0)`) = a genuine TIGHTEN (arming now needs
    ///           a second signature) → INSTANT + `_bumpSigningEpoch()` so in-flight single-factor arms die
    ///           and must re-arm under 2-of-2 (no window where a pre-armed digest bypasses the new factor).
    ///         - REMOVE (`next == address(0)`) or SWAP (`next != current`) = a loosen-in-disguise (the move
    ///           a compromised owner makes to defeat the factor) → TIMELOCKED via `pendingCoSigner`/`applyCoSigner`.
    ///         Re-asserting the SAME value (`next == current`) is a true no-op that CANCELS any pending weakening
    ///         (no epoch bump, no spurious pending/event). Guardian has NO co-signer authority (owner-only).
    function setCoSigner(address next) external onlyOwner {
        address cur = coSigner;
        if (next == cur) {
            // No change requested — cancel any pending weakening and return (no epoch bump, no event). This also
            // keeps a pending swap/remove from being staged under a misleading same-value CoSignerChanged later
            // (Gate-② FP4-P2 finding): applyCoSigner on a no-op would needlessly bump the epoch + emit X→X.
            _clearPendingCoSigner();
            return;
        }
        if (cur == address(0)) {
            // ADD the factor (`0 → X`) — a genuine tighten → INSTANT + epoch bump (in-flight single-factor arms die).
            coSigner = next;
            _bumpSigningEpoch();
            emit CoSignerChanged(address(0), next);
        } else {
            // REMOVE (`X → 0`) or SWAP (`X → Y≠X`) — a loosen-in-disguise → TIMELOCKED. (A pending weakening is
            // also cancelled by `revoke`, which clears every pending slot via `_clearPendingTimelocks`.)
            pendingCoSigner = next;
            pendingCoSignerEta = uint64(block.timestamp) + timelockDelay;
            emit CoSignerProposed(cur, next, pendingCoSignerEta);
        }
    }

    /// @notice Execute a pending co-signer weakening (remove/swap) after its timelock elapses. Bumps the
    ///         signing epoch so an intent armed under the old co-signer regime cannot survive the change
    ///         (SR-3). Owner-only.
    function applyCoSigner() external onlyOwner {
        uint64 eta = pendingCoSignerEta;
        if (eta == 0) revert NothingPending();
        if (block.timestamp < eta) revert TimelockNotElapsed(eta);
        address next = pendingCoSigner;
        emit CoSignerChanged(coSigner, next);
        coSigner = next;
        _clearPendingCoSigner();
        _bumpSigningEpoch();
    }

    function _clearPendingCoSigner() internal {
        delete pendingCoSigner;
        delete pendingCoSignerEta;
    }

    // ---------- session policy: tighten INSTANT; loosen = proposeGoverned(kind 3) ----------

    function tightenSession(PolicyLib.SessionPolicy calldata p) external onlyOwner {
        if (p.ruleWindowSeconds == 0) revert InvalidPolicy();
        PolicyLib.SessionPolicy memory cur = session;
        if (p.ruleWindowSeconds < cur.ruleWindowSeconds || p.expiresAt > cur.expiresAt) revert NotTightening();
        session = p;
        _clearGovernedIf(3);
        emit SessionPolicyChanged(p);
    }

    // ---------- per-asset allowlist: additions = proposeGoverned(kind 4); removals instant ----------

    function removeAllowlist(address asset, address to) external onlyOwner {
        allowlist[asset][to] = false;
        _clearGovernedIf(4);
        emit AllowlistRemoved(asset, to);
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
