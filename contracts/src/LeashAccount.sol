// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title LeashAccount — self-enforcing constrained account for one LEASH agent.
/// @notice The agent holds only a session key; every spend is checked in-contract:
///         per-transfer cap, fixed (tumbling) window cap, expiry, allowlist
///         default-deny. Two spend paths, both leashed:
///         - `execute` — NATIVE transfers only (`data.length == 0`); arbitrary
///           calldata is impossible by construction (reverts `CalldataForbidden`).
///         - `executeTokenTransfer` — a single, immutable settlement ERC-20
///           (Phase 4). The account itself builds `IERC20.transfer(to, amount)`;
///           the agent supplies NO calldata, so there is still no arbitrary-call
///           path. Bounded by its OWN per-transfer + window caps, the shared
///           recipient allowlist, and the shared expiry/revoke.
///         Owner is sole policy authority; the guardian can only revoke (refuse),
///         never move funds or change policy. Loosening changes are timelocked;
///         tightening is instant. Native-only accounts set `settlementToken` to
///         `address(0)` (every legacy v2 account + every provider/evaluator).
/// @dev    Both spend windows are FIXED (tumbling), not rolling: the counter resets
///         via lazy rollover on the first spend past the boundary, so the worst-case
///         burst across a window boundary is <=2x windowCap (native AND token share
///         `policy.windowSeconds`). Timelock queues are single-pending slots: a new
///         propose OVERWRITES the pending item and resets its eta; `revoke()` and
///         `tightenPolicy()` clear ALL pending slots (native, allowlist, withdraw,
///         AND token).
contract LeashAccount is ReentrancyGuard {
    struct Policy {
        uint128 perTransferCap;
        uint128 windowCap;
        uint32 windowSeconds;
        uint64 expiresAt;
    }

    /// @notice Per-token spend caps. The window DURATION is shared with the native
    ///         policy (`policy.windowSeconds`); only the caps are token-specific.
    struct TokenPolicy {
        uint128 perTransferCapToken;
        uint128 windowCapToken;
    }

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
    // Phase 4 — token settlement path (calldata reopening, narrowest form).
    error NoSettlementToken();
    error TokenNotAllowlisted(address token);
    error OverPerTransferCapToken(uint256 amount, uint128 cap);
    error OverWindowCapToken(uint256 attempted, uint128 cap);
    error TokenTransferFailed();

    event Executed(address indexed to, uint256 value, uint128 spentInWindow);
    event TokenExecuted(address indexed token, address indexed to, uint256 amount, uint128 spentInWindowToken);
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

    address public immutable owner;
    address public guardian;
    address public sessionKey;
    bool public revoked;

    Policy public policy;
    uint128 public spentInWindow;
    uint64 public windowStart;

    // Phase 4 — single immutable settlement token (address(0) = native-only
    // account: every legacy v2 account + every provider/evaluator). Changing the
    // token is neither a clean tighten nor loosen and would widen the attack
    // surface (F3), so a different token = a different account.
    address public immutable settlementToken;
    TokenPolicy public tokenPolicy;
    uint128 public spentInWindowToken;
    uint64 public windowStartToken;

    mapping(address => bool) public allowlist;

    uint64 public immutable timelockDelay;

    // single-pending timelock slots (a new propose OVERWRITES the pending one and resets eta)
    Policy public pendingPolicy;
    uint64 public pendingPolicyEta; // 0 = none
    address public pendingAllowlistAddr;
    uint64 public pendingAllowlistEta; // 0 = none
    address public pendingWithdrawTo;
    uint256 public pendingWithdrawAmount;
    uint64 public pendingWithdrawEta; // 0 = none
    TokenPolicy public pendingTokenPolicy;
    uint64 public pendingTokenPolicyEta; // 0 = none

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
        // Immutable settlement token (address(0) = native-only account). When set,
        // seed the token caps + window; when unset the token caps stay zero and
        // `executeTokenTransfer` reverts `NoSettlementToken`.
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

    // ---------- the leash: agent execution ----------

    /// @notice The ONLY path the agent (session key) has. Native transfers only.
    function execute(address to, uint256 value, bytes calldata data) external nonReentrant {
        if (msg.sender != sessionKey) revert NotSessionKey();
        if (revoked) revert AccountRevoked();
        Policy memory p = policy;
        // RECORDED SEMANTIC (C-6): strict `>` — a transfer in the exact
        // `expiresAt` second is still accepted (inclusive-at-expiry). Kept as
        // deployed (no redeploy for a 1-second boundary); pinned by
        // test_execute_atExactExpirySecond_isAcceptedInclusiveSemantics.
        if (block.timestamp > p.expiresAt) revert SessionExpired();
        if (to == address(0)) revert ZeroAddress();
        if (!allowlist[to]) revert NotAllowlisted(to);
        if (data.length != 0) revert CalldataForbidden();
        if (value > p.perTransferCap) revert OverPerTransferCap(value, p.perTransferCap);

        // lazy rollover of the FIXED (tumbling) window: first spend past the boundary
        // resets the counter, so a burst across a boundary can reach <=2x windowCap
        uint64 start = windowStart;
        if (block.timestamp >= uint256(start) + p.windowSeconds) {
            windowStart = uint64(block.timestamp);
            spentInWindow = 0;
        }
        uint256 attempted = uint256(spentInWindow) + value;
        if (attempted > p.windowCap) revert OverWindowCap(attempted, p.windowCap);

        // CEI: account for the spend BEFORE the external call
        spentInWindow = uint128(attempted);
        emit Executed(to, value, uint128(attempted));

        (bool ok,) = to.call{value: value}("");
        if (!ok) revert CallFailed();
    }

    /// @notice The agent's ONLY ERC-20 path: transfer the single immutable
    ///         `settlementToken` to an allowlisted recipient, within the token
    ///         per-transfer + window caps. The account BUILDS the calldata
    ///         (`IERC20.transfer(to, amount)`) — the agent supplies none, so
    ///         there is still no arbitrary-call path (D-JOB-6). Native path is
    ///         untouched: `execute` still reverts `CalldataForbidden`.
    /// @dev    Same leash order as `execute`: session-key, revoke, expiry, zero,
    ///         allowlist, token match, per-transfer cap, tumbling window cap,
    ///         then CEI (account BEFORE the external call) under `nonReentrant`.
    ///         A malicious/reentrant token cannot double-spend (guard + CEI) nor
    ///         fake success (SafeERC20-style return check).
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

        // lazy rollover of the token's FIXED (tumbling) window, sharing the
        // account's window DURATION (policy.windowSeconds) — worst-case burst
        // across a boundary is <=2x windowCapToken (same M-02 acceptance).
        uint64 start = windowStartToken;
        if (block.timestamp >= uint256(start) + p.windowSeconds) {
            windowStartToken = uint64(block.timestamp);
            spentInWindowToken = 0;
        }
        uint256 attempted = uint256(spentInWindowToken) + amount;
        if (attempted > tp.windowCapToken) revert OverWindowCapToken(attempted, tp.windowCapToken);

        // CEI: account for the spend BEFORE the external call
        spentInWindowToken = uint128(attempted);
        emit TokenExecuted(token, to, amount, uint128(attempted));

        // The contract builds the calldata — the agent never supplies it.
        // SafeERC20-style return check: ok && (no returndata || decoded true).
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TokenTransferFailed();
    }

    // ---------- revoke / re-arm ----------

    /// @dev Clears every pending timelock slot (L-05) so no matured loosening,
    ///      allowlist addition, or withdraw stays armed after the state change.
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

    /// @notice address(0) removes the guardian entirely.
    function setGuardian(address g) external onlyOwner {
        emit GuardianChanged(guardian, g);
        guardian = g;
    }

    // ---------- policy: tightening instant, loosening timelocked ----------

    /// @dev Loosening = any of: per-transfer cap raised, window cap raised,
    ///      window shortened, expiry extended.
    function _isLoosening(Policy memory p) internal view returns (bool) {
        Policy memory cur = policy;
        return p.perTransferCap > cur.perTransferCap || p.windowCap > cur.windowCap
            || p.windowSeconds < cur.windowSeconds || p.expiresAt > cur.expiresAt;
    }

    /// @dev Also clears ALL pending timelock slots: a tightening owner must not
    ///      leave a matured loosening (or allowlist add / withdraw) armed.
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

    /// @dev Loosening = either token cap raised. The window DURATION is the
    ///      native `policy.windowSeconds` (shared), governed by tighten/proposePolicy.
    function _isTokenLoosening(TokenPolicy memory p) internal view returns (bool) {
        TokenPolicy memory cur = tokenPolicy;
        return p.perTransferCapToken > cur.perTransferCapToken || p.windowCapToken > cur.windowCapToken;
    }

    /// @dev Also clears ALL pending timelock slots (L-05), incl. the token slot.
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
