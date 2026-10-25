// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {PolicyLib} from "./PolicyLib.sol";

/// @dev The slice of LeashAccountV6 the module needs. The two `module*` writers are gated
///      `msg.sender == envelopeModule` in the account and RE-VALIDATE G-1 in-account.
interface ILeashAccountV6 {
    function owner() external view returns (address);
    function guardian() external view returns (address);
    function sessionKey() external view returns (address);
    function revoked() external view returns (bool);
    function timelockDelay() external view returns (uint64);
    function session() external view returns (uint32 ruleWindowSeconds, uint64 expiresAt);
    function assetPolicy(address asset)
        external
        view
        returns (bool enabled, uint128 perTransferCap, uint128 windowCap, uint32 windowSeconds);
    function knownPayee(address payee) external view returns (bool);
    function moduleSetAssetPolicy(address asset, PolicyLib.AssetPolicy calldata p) external;
    function moduleAddPayee(address asset, address payee) external;
}

/// @title LeashEnvelopeModuleV6 — the AQ-FND M-2 owner envelope + agent self-extension,
///        as a stateful companion SINGLETON (one deploy serves every v6 account, keyed by
///        account address — the audited Safe-Allowance-Module / Zodiac-Delay shape the
///        AQ-FND research names as the proven analogs).
/// @notice WHY A MODULE (EIP-170): V5 is 24,264 of 24,576 bytes; the M-1 multi-asset model
///         already consumes the slack. The envelope grammar is the one subsystem whose write
///         path is BY CONSTRUCTION pre-authorized (the owner committed the ceilings on the
///         slow path), so it can mediate authority-changes from outside the account without
///         weakening the wall: every spend-time guarantee (per-asset meters, caps, payee
///         allowlists, call rules, signing budgets, the `BudgetNotSet` novel-token floor)
///         remains enforced INSIDE the account. The module can only ever reach the account
///         through `moduleSetAssetPolicy`/`moduleAddPayee`, which re-validate G-1 and refuse
///         when revoked. The module address is an account IMMUTABLE baked into the CREATE2
///         initcode (pinned cross-chain like SigningLib/DecodeLib/PolicyLib).
///
///         D-1 = B+C+D mapping:
///         · B — the owner commits per-asset ceilings (timelocked propose→apply, the
///           account's own `timelockDelay`); the agent ENABLES an envelope-covered asset
///           instantly iff its caps are a strict subset (G-6) and the move is not sharp.
///         · C — a SHARP move (windowCap above `sharpBps` of the ceiling, a widening of a
///           live policy, or a never-seen payee) queues behind `vetoDelay`; the owner or
///           guardian can VETO; otherwise the agent applies it after the window — a veto,
///           not an approve.
///         · D — the account's `revoke()`/`disableAsset` stay the instant backstop; a
///           revoked account refuses module writes.
///         Attenuation law: nothing here lets the agent exceed owner-committed bounds; the
///         agent's own tighten path lives in the account (`tightenAssetPolicy`).
contract LeashEnvelopeModuleV6 {
    error NotOwner();
    error NotGuardianOrOwner();
    error NotSessionKey();
    error AccountRevoked();
    error SessionExpired();
    error NothingPending();
    error TimelockNotElapsed(uint64 eta);
    error NotTightening();
    error OutsideEnvelope(address asset); // G-6
    error AgentActionPending();
    error NoAgentActionPending();
    error VetoNotElapsed(uint64 eta);
    error CommitMismatch();
    error InvalidPolicy();

    event EnvelopeProposed(address indexed account, address indexed asset, PolicyLib.EnvelopeEntry e, uint64 eta);
    event EnvelopeChanged(address indexed account, address indexed asset, PolicyLib.EnvelopeEntry e);
    event EnvelopeRemoved(address indexed account, address indexed asset);
    event EnvelopeConfigChanged(address indexed account, uint64 vetoDelay, uint32 sharpBps);
    event AgentAssetEnabled(address indexed account, address indexed asset, PolicyLib.AssetPolicy p, bool queued);
    event AgentPayeeAdded(address indexed account, address indexed asset, address payee, bool queued);
    event AgentActionQueued(address indexed account, uint8 kind, address indexed asset, address payee, uint64 eta);
    event AgentActionVetoed(address indexed account, address indexed by);
    event AgentActionApplied(address indexed account, uint8 kind, address indexed asset);

    /// @notice Per-account veto parameters. Set-or-tightened instantly by the owner
    ///         (`vetoDelay` up = tighter, `sharpBps` down = tighter); LOOSENING them rides the
    ///         account-timelocked envelope propose path (kind 0 config proposal).
    struct VetoConfig {
        bool set;
        uint64 vetoDelay;
        uint32 sharpBps; // of the envelope ceiling, in bps (10_000 = 100%)
    }

    mapping(address => mapping(address => PolicyLib.EnvelopeEntry)) public envelope; // account => asset
    mapping(address => VetoConfig) public vetoConfig; // account
    // one timelocked owner proposal per account: commit = keccak(kind, payload)
    mapping(address => bytes32) internal pendingCommit;
    mapping(address => uint64) public pendingEta;
    // one queued agent action per account: commit = keccak(kind, asset, payload)
    mapping(address => bytes32) internal agentCommit;
    mapping(address => uint64) public agentEta;

    // proposal kinds: 1 = envelope entry, 2 = veto config (loosen)
    // agent kinds:    1 = enable asset,   2 = add payee

    function _acct(address account) internal view returns (ILeashAccountV6 a) {
        a = ILeashAccountV6(account);
    }

    function _onlyOwner(address account) internal view {
        if (msg.sender != _acct(account).owner()) revert NotOwner();
    }

    function _onlyLiveSession(address account) internal view {
        ILeashAccountV6 a = _acct(account);
        if (msg.sender != a.sessionKey()) revert NotSessionKey();
        if (a.revoked()) revert AccountRevoked();
        (, uint64 expiresAt) = a.session();
        if (block.timestamp > expiresAt) revert SessionExpired();
    }

    // ---------- owner grammar: commit/expand = timelocked · tighten/remove = instant ----------

    /// @notice Propose an envelope entry (kind 1, payload = abi.encode(asset, EnvelopeEntry))
    ///         or a veto-config loosen (kind 2, payload = abi.encode(VetoConfig)). Timelocked
    ///         on the ACCOUNT's own `timelockDelay` — the envelope pays the slow-path cost once.
    function propose(address account, uint8 kind, bytes calldata payload) external {
        _onlyOwner(account);
        if (kind == 1) {
            (, PolicyLib.EnvelopeEntry memory e) = abi.decode(payload, (address, PolicyLib.EnvelopeEntry));
            if (e.minWindowSeconds == 0 || e.maxWindowCap < e.maxPerTransferCap) revert InvalidPolicy();
        } else if (kind == 2) {
            VetoConfig memory vc = abi.decode(payload, (VetoConfig));
            if (vc.sharpBps > 10_000) revert InvalidPolicy();
        } else {
            revert InvalidPolicy();
        }
        pendingCommit[account] = keccak256(abi.encode(kind, payload));
        uint64 eta = uint64(block.timestamp) + _acct(account).timelockDelay();
        pendingEta[account] = eta;
        if (kind == 1) {
            (address asset, PolicyLib.EnvelopeEntry memory e) = abi.decode(payload, (address, PolicyLib.EnvelopeEntry));
            emit EnvelopeProposed(account, asset, e, eta);
        }
    }

    function apply_(address account, uint8 kind, bytes calldata payload) external {
        _onlyOwner(account);
        uint64 eta = pendingEta[account];
        if (eta == 0) revert NothingPending();
        if (block.timestamp < eta) revert TimelockNotElapsed(eta);
        if (keccak256(abi.encode(kind, payload)) != pendingCommit[account]) revert CommitMismatch();
        if (kind == 1) {
            (address asset, PolicyLib.EnvelopeEntry memory e) = abi.decode(payload, (address, PolicyLib.EnvelopeEntry));
            e.set = true;
            envelope[account][asset] = e;
            emit EnvelopeChanged(account, asset, e);
        } else {
            VetoConfig memory vc = abi.decode(payload, (VetoConfig));
            vc.set = true;
            vetoConfig[account] = vc;
            emit EnvelopeConfigChanged(account, vc.vetoDelay, vc.sharpBps);
        }
        _clearPending(account);
    }

    /// @notice Shrink an envelope ceiling — TIGHTENING → INSTANT (owner).
    function tightenEnvelope(address account, address asset, PolicyLib.EnvelopeEntry calldata e) external {
        _onlyOwner(account);
        PolicyLib.EnvelopeEntry storage cur = envelope[account][asset];
        if (!cur.set) revert OutsideEnvelope(asset);
        if (
            e.maxPerTransferCap > cur.maxPerTransferCap || e.maxWindowCap > cur.maxWindowCap
                || e.minWindowSeconds < cur.minWindowSeconds
        ) revert NotTightening();
        PolicyLib.EnvelopeEntry memory next = e;
        next.set = true;
        envelope[account][asset] = next;
        emit EnvelopeChanged(account, asset, next);
    }

    /// @notice Tighten the veto parameters — INSTANT (longer veto window, lower sharp threshold).
    function tightenVetoConfig(address account, uint64 vetoDelay, uint32 sharpBps) external {
        _onlyOwner(account);
        VetoConfig storage cur = vetoConfig[account];
        if (cur.set && (vetoDelay < cur.vetoDelay || sharpBps > cur.sharpBps)) revert NotTightening();
        if (sharpBps > 10_000) revert InvalidPolicy();
        vetoConfig[account] = VetoConfig({set: true, vetoDelay: vetoDelay, sharpBps: sharpBps});
        emit EnvelopeConfigChanged(account, vetoDelay, sharpBps);
    }

    /// @notice Remove an envelope entry — TIGHTENING → INSTANT. The asset's live policy is
    ///         untouched (disable it on the account); the agent just can't re-enable it.
    function removeEnvelope(address account, address asset) external {
        _onlyOwner(account);
        delete envelope[account][asset];
        emit EnvelopeRemoved(account, asset);
    }

    // ---------- agent self-extension: B instant · C veto-queued (G-6) ----------

    /// @notice The agent enables an envelope-covered asset. Strict-subset caps (G-6); below
    ///         the sharp threshold and not widening a live policy → INSTANT; else queued
    ///         behind the veto window.
    function agentEnableAsset(address account, PolicyLib.AssetPolicy calldata p, address asset) external {
        _onlyLiveSession(account);
        PolicyLib.EnvelopeEntry storage e = envelope[account][asset];
        if (!e.set) revert OutsideEnvelope(asset); // G-6: beyond the envelope → refused on-chain
        if (
            p.perTransferCap > e.maxPerTransferCap || p.windowCap > e.maxWindowCap
                || p.windowSeconds < e.minWindowSeconds
        ) revert OutsideEnvelope(asset);
        VetoConfig storage vc = vetoConfig[account];

        (bool enabled, uint128 curPtc, uint128 curWc, uint32 curWs,) = _livePolicy(account, asset);
        bool widensLive = enabled && (p.perTransferCap > curPtc || p.windowCap > curWc || p.windowSeconds < curWs);
        bool sharp = uint256(p.windowCap) * 10_000 > uint256(e.maxWindowCap) * (vc.set ? vc.sharpBps : 0);

        if (!sharp && !widensLive) {
            _acct(account).moduleSetAssetPolicy(asset, p);
            emit AgentAssetEnabled(account, asset, p, false);
        } else {
            if (agentEta[account] != 0) revert AgentActionPending();
            agentCommit[account] = keccak256(abi.encode(uint8(1), asset, p));
            uint64 eta = uint64(block.timestamp) + (vc.set ? vc.vetoDelay : _acct(account).timelockDelay());
            agentEta[account] = eta;
            emit AgentAssetEnabled(account, asset, p, true);
            emit AgentActionQueued(account, 1, asset, address(0), eta);
        }
    }

    /// @notice The agent adds a payee to an enabled, envelope-covered asset. A payee already
    ///         known on any asset → INSTANT; a never-seen counterparty is the canonical sharp
    ///         move → veto window.
    function agentAddPayee(address account, address asset, address payee) external {
        _onlyLiveSession(account);
        if (payee == address(0)) revert InvalidPolicy();
        if (!envelope[account][asset].set) revert OutsideEnvelope(asset);
        (bool enabled,,,,) = _livePolicy(account, asset);
        if (!enabled) revert OutsideEnvelope(asset);

        if (_acct(account).knownPayee(payee)) {
            _acct(account).moduleAddPayee(asset, payee);
            emit AgentPayeeAdded(account, asset, payee, false);
        } else {
            if (agentEta[account] != 0) revert AgentActionPending();
            agentCommit[account] = keccak256(abi.encode(uint8(2), asset, payee));
            VetoConfig storage vc = vetoConfig[account];
            uint64 eta = uint64(block.timestamp) + (vc.set ? vc.vetoDelay : _acct(account).timelockDelay());
            agentEta[account] = eta;
            emit AgentPayeeAdded(account, asset, payee, true);
            emit AgentActionQueued(account, 2, asset, payee, eta);
        }
    }

    /// @notice Apply a queued agent action after its un-vetoed window elapsed — agent-callable
    ///         (veto, not approve). Re-validated against the LIVE envelope (the owner may have
    ///         tightened it mid-window).
    function agentApplyQueued(address account, uint8 kind, address asset, PolicyLib.AssetPolicy calldata p, address payee)
        external
    {
        _onlyLiveSession(account);
        uint64 eta = agentEta[account];
        if (eta == 0) revert NoAgentActionPending();
        if (block.timestamp < eta) revert VetoNotElapsed(eta);
        if (kind == 1) {
            if (keccak256(abi.encode(uint8(1), asset, p)) != agentCommit[account]) revert CommitMismatch();
            PolicyLib.EnvelopeEntry storage e = envelope[account][asset];
            if (!e.set) revert OutsideEnvelope(asset);
            if (
                p.perTransferCap > e.maxPerTransferCap || p.windowCap > e.maxWindowCap
                    || p.windowSeconds < e.minWindowSeconds
            ) revert OutsideEnvelope(asset);
            _acct(account).moduleSetAssetPolicy(asset, p);
        } else {
            if (keccak256(abi.encode(uint8(2), asset, payee)) != agentCommit[account]) revert CommitMismatch();
            _acct(account).moduleAddPayee(asset, payee);
        }
        _clearAgent(account);
        emit AgentActionApplied(account, kind, asset);
    }

    /// @notice VETO the queued agent action — owner OR guardian, INSTANT (the C-tier control).
    function vetoAgentAction(address account) external {
        ILeashAccountV6 a = _acct(account);
        if (msg.sender != a.owner() && msg.sender != a.guardian()) revert NotGuardianOrOwner();
        if (agentEta[account] == 0) revert NoAgentActionPending();
        _clearAgent(account);
        emit AgentActionVetoed(account, msg.sender);
    }

    function _livePolicy(address account, address asset)
        internal
        view
        returns (bool enabled, uint128 perTransferCap, uint128 windowCap, uint32 windowSeconds, ILeashAccountV6 a)
    {
        a = _acct(account);
        (enabled, perTransferCap, windowCap, windowSeconds) = a.assetPolicy(asset);
    }

    function _clearPending(address account) internal {
        pendingCommit[account] = 0;
        pendingEta[account] = 0;
    }

    function _clearAgent(address account) internal {
        agentCommit[account] = 0;
        agentEta[account] = 0;
    }
}
