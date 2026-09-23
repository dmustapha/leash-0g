// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {LeashAccount} from "../src/LeashAccount.sol";

contract Reenterer {
    LeashAccount public target;
    bool public attempted;
    bool public reentrySucceeded;

    function setTarget(LeashAccount t) external {
        target = t;
    }

    receive() external payable {
        attempted = true;
        // try to re-enter execute mid-call; MUST fail (nonReentrant / onlySessionKey)
        try target.execute(address(this), 1, "") {
            reentrySucceeded = true;
        } catch {}
    }
}

contract RejectingReceiver {
    receive() external payable {
        revert("no thanks");
    }
}

contract LeashAccountTest is Test {
    LeashAccount internal acct;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal session = makeAddr("session");
    address internal dest = makeAddr("beneficiary");
    address internal rando = makeAddr("rando");

    uint128 constant PER_TX_CAP = 1 ether;
    uint128 constant WINDOW_CAP = 3 ether;
    uint32 constant WINDOW_SECONDS = 1 hours;
    uint64 constant DELAY = 15 minutes;

    function _policy() internal view returns (LeashAccount.Policy memory) {
        return LeashAccount.Policy({
            perTransferCap: PER_TX_CAP,
            windowCap: WINDOW_CAP,
            windowSeconds: WINDOW_SECONDS,
            expiresAt: uint64(block.timestamp + 30 days)
        });
    }

    function _tokenNone() internal pure returns (LeashAccount.TokenPolicy memory) {
        return LeashAccount.TokenPolicy({perTransferCapToken: 0, windowCapToken: 0});
    }

    function _deploy() internal returns (LeashAccount) {
        address[] memory list = new address[](1);
        list[0] = dest;
        return new LeashAccount(owner, guardian, session, _policy(), list, DELAY, address(0), _tokenNone());
    }

    function setUp() public {
        vm.warp(1_700_000_000);
        acct = _deploy();
        vm.deal(address(acct), 100 ether);
    }

    // ---------- construction ----------

    function test_constructor_setsRolesPolicyAllowlist() public view {
        assertEq(acct.owner(), owner);
        assertEq(acct.guardian(), guardian);
        assertEq(acct.sessionKey(), session);
        assertFalse(acct.revoked());
        (uint128 ptc, uint128 wc, uint32 ws, uint64 exp) = acct.policy();
        assertEq(ptc, PER_TX_CAP);
        assertEq(wc, WINDOW_CAP);
        assertEq(ws, WINDOW_SECONDS);
        assertEq(exp, uint64(block.timestamp + 30 days));
        assertTrue(acct.allowlist(dest));
        assertFalse(acct.allowlist(rando));
        assertEq(acct.timelockDelay(), DELAY);
    }

    function test_constructor_rejectsZeroOwnerOrSessionKey() public {
        address[] memory list = new address[](0);
        vm.expectRevert(LeashAccount.ZeroAddress.selector);
        new LeashAccount(address(0), guardian, session, _policy(), list, DELAY, address(0), _tokenNone());
        vm.expectRevert(LeashAccount.ZeroAddress.selector);
        new LeashAccount(owner, guardian, address(0), _policy(), list, DELAY, address(0), _tokenNone());
    }

    function test_receive_acceptsDeposits() public {
        vm.deal(rando, 1 ether);
        vm.prank(rando);
        (bool ok,) = address(acct).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(acct).balance, 101 ether);
    }

    // ---------- execute: happy path ----------

    function test_execute_inPolicyTransfer_succeeds() public {
        uint256 before = dest.balance;
        vm.prank(session);
        acct.execute(dest, 0.5 ether, "");
        assertEq(dest.balance, before + 0.5 ether);
        assertEq(acct.spentInWindow(), 0.5 ether);
    }

    function test_execute_emitsExecuted() public {
        vm.expectEmit(true, false, false, true);
        emit LeashAccount.Executed(dest, 0.5 ether, 0.5 ether);
        vm.prank(session);
        acct.execute(dest, 0.5 ether, "");
    }

    // ---------- execute: every policy check reverts ----------

    function test_execute_revertsForNonSessionCaller() public {
        vm.prank(owner); // even the owner is not the session key
        vm.expectRevert(LeashAccount.NotSessionKey.selector);
        acct.execute(dest, 0.1 ether, "");
        vm.prank(rando);
        vm.expectRevert(LeashAccount.NotSessionKey.selector);
        acct.execute(dest, 0.1 ether, "");
    }

    function test_execute_revertsOverPerTransferCap() public {
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccount.OverPerTransferCap.selector, PER_TX_CAP + 1, PER_TX_CAP));
        acct.execute(dest, uint256(PER_TX_CAP) + 1, "");
    }

    function test_execute_revertsOffAllowlist() public {
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccount.NotAllowlisted.selector, rando));
        acct.execute(rando, 0.1 ether, "");
    }

    function test_execute_revertsZeroAddress() public {
        vm.prank(session);
        vm.expectRevert(LeashAccount.ZeroAddress.selector);
        acct.execute(address(0), 0.1 ether, "");
    }

    function test_execute_revertsOnCalldata() public {
        vm.prank(session);
        vm.expectRevert(LeashAccount.CalldataForbidden.selector);
        acct.execute(dest, 0.1 ether, hex"deadbeef");
    }

    function test_execute_revertsWhenExpired() public {
        vm.warp(block.timestamp + 31 days);
        vm.prank(session);
        vm.expectRevert(LeashAccount.SessionExpired.selector);
        acct.execute(dest, 0.1 ether, "");
    }

    /// C-6 pin: the deployed strict-`>` check means a transfer in the EXACT
    /// expiresAt second is still accepted (inclusive-at-expiry). Recorded
    /// semantic — this test failing means the boundary silently changed.
    function test_execute_atExactExpirySecond_isAcceptedInclusiveSemantics() public {
        uint64 expiry = _policy().expiresAt;
        vm.warp(expiry); // block.timestamp == expiresAt
        vm.prank(session);
        acct.execute(dest, 0.1 ether, "");
        assertEq(dest.balance, 0.1 ether);
        // one second later: default-deny
        vm.warp(uint256(expiry) + 1);
        vm.prank(session);
        vm.expectRevert(LeashAccount.SessionExpired.selector);
        acct.execute(dest, 0.1 ether, "");
    }

    /// Phase-2 spend-incapable preset (sentinel-A): zero caps + empty
    /// allowlist ⇒ EVERY execute reverts — the account informs, never spends.
    function test_spendIncapablePolicy_zeroCaps_anyExecuteReverts() public {
        address[] memory emptyList = new address[](0);
        LeashAccount incapable = new LeashAccount(
            owner,
            guardian,
            session,
            LeashAccount.Policy({
                perTransferCap: 0, windowCap: 0, windowSeconds: 1 hours, expiresAt: uint64(block.timestamp + 30 days)
            }),
            emptyList,
            DELAY,
            address(0),
            _tokenNone()
        );
        vm.deal(address(incapable), 1 ether);
        vm.startPrank(session);
        // off-allowlist (default-deny) — even 1 wei to anyone
        vm.expectRevert(abi.encodeWithSelector(LeashAccount.NotAllowlisted.selector, dest));
        incapable.execute(dest, 1, "");
        vm.expectRevert(abi.encodeWithSelector(LeashAccount.NotAllowlisted.selector, rando));
        incapable.execute(rando, 1, "");
        vm.stopPrank();
        // even after the owner allowlists a destination (timelocked add), the
        // ZERO per-transfer cap still refuses every amount — layered default-deny
        vm.startPrank(owner);
        incapable.proposeAllowlist(dest);
        vm.warp(block.timestamp + DELAY + 1);
        incapable.applyAllowlist();
        vm.stopPrank();
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccount.OverPerTransferCap.selector, 1, 0));
        incapable.execute(dest, 1, "");
        assertEq(address(incapable).balance, 1 ether); // nothing ever moved
    }

    function test_execute_revertsOverWindowCap() public {
        vm.startPrank(session);
        acct.execute(dest, 1 ether, "");
        acct.execute(dest, 1 ether, "");
        acct.execute(dest, 1 ether, ""); // 3 ether spent = windowCap
        vm.expectRevert(abi.encodeWithSelector(LeashAccount.OverWindowCap.selector, 3 ether + 0.1 ether, WINDOW_CAP));
        acct.execute(dest, 0.1 ether, "");
        vm.stopPrank();
    }

    function test_execute_windowRollsOverAfterWindowSeconds() public {
        vm.startPrank(session);
        acct.execute(dest, 1 ether, "");
        acct.execute(dest, 1 ether, "");
        acct.execute(dest, 1 ether, "");
        // exactly at the boundary the window resets
        vm.warp(block.timestamp + WINDOW_SECONDS);
        acct.execute(dest, 1 ether, "");
        assertEq(acct.spentInWindow(), 1 ether);
        vm.stopPrank();
    }

    function test_execute_windowNotResetBeforeBoundary() public {
        vm.startPrank(session);
        acct.execute(dest, 1 ether, "");
        acct.execute(dest, 1 ether, "");
        acct.execute(dest, 1 ether, "");
        vm.warp(block.timestamp + WINDOW_SECONDS - 1);
        vm.expectRevert(abi.encodeWithSelector(LeashAccount.OverWindowCap.selector, 4 ether, WINDOW_CAP));
        acct.execute(dest, 1 ether, "");
        vm.stopPrank();
    }

    /// @dev DOCUMENTS accepted semantics (M-02): the window is FIXED (tumbling) with
    ///      lazy rollover, not rolling. Spending windowCap right before a boundary and
    ///      windowCap right after it is allowed — worst-case burst is 2x windowCap.
    function test_execute_boundaryBurst_upToTwiceWindowCap_isAcceptedTumblingSemantics() public {
        uint256 before = dest.balance;
        vm.startPrank(session);
        // fill the window cap at the end of the current window
        acct.execute(dest, 1 ether, "");
        acct.execute(dest, 1 ether, "");
        acct.execute(dest, 1 ether, ""); // spentInWindow == WINDOW_CAP
        // cross the boundary; lazy rollover resets the counter
        vm.warp(block.timestamp + WINDOW_SECONDS);
        acct.execute(dest, 1 ether, "");
        acct.execute(dest, 1 ether, "");
        acct.execute(dest, 1 ether, ""); // a second full WINDOW_CAP
        vm.stopPrank();
        assertEq(dest.balance, before + 2 * uint256(WINDOW_CAP)); // 2x cap across the boundary
        assertEq(acct.spentInWindow(), WINDOW_CAP);
    }

    function test_execute_revertsAfterRevoke() public {
        vm.prank(guardian);
        acct.revoke();
        vm.prank(session);
        vm.expectRevert(LeashAccount.AccountRevoked.selector);
        acct.execute(dest, 0.1 ether, "");
    }

    function test_execute_bubblesFailedCall_andRollsBackSpend() public {
        RejectingReceiver r = new RejectingReceiver();
        // owner tightens nothing; add r via timelock
        vm.prank(owner);
        acct.proposeAllowlist(address(r));
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applyAllowlist();

        vm.prank(session);
        vm.expectRevert(LeashAccount.CallFailed.selector);
        acct.execute(address(r), 0.1 ether, "");
        assertEq(acct.spentInWindow(), 0);
    }

    // ---------- reentrancy ----------

    function test_execute_reentrancyAttackerCannotReenter() public {
        Reenterer attacker = new Reenterer();
        attacker.setTarget(acct);
        vm.prank(owner);
        acct.proposeAllowlist(address(attacker));
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applyAllowlist();

        vm.prank(session);
        acct.execute(address(attacker), 0.5 ether, "");
        assertTrue(attacker.attempted());
        assertFalse(attacker.reentrySucceeded());
        assertEq(acct.spentInWindow(), 0.5 ether); // only the outer spend counted
    }

    // ---------- revoke / rearm ----------

    function test_revoke_byOwner_and_byGuardian_notByRando() public {
        vm.prank(rando);
        vm.expectRevert(LeashAccount.NotGuardianOrOwner.selector);
        acct.revoke();

        vm.prank(guardian);
        acct.revoke();
        assertTrue(acct.revoked());

        // rearm and revoke again as owner
        vm.prank(owner);
        acct.rearm();
        assertFalse(acct.revoked());
        vm.prank(owner);
        acct.revoke();
        assertTrue(acct.revoked());
    }

    function test_rearm_ownerOnly_guardianCannot() public {
        vm.prank(guardian);
        acct.revoke();
        vm.prank(guardian);
        vm.expectRevert(LeashAccount.NotOwner.selector);
        acct.rearm();
    }

    function test_revoke_emitsRevokedWithCaller() public {
        vm.expectEmit(true, false, false, false);
        emit LeashAccount.Revoked(guardian);
        vm.prank(guardian);
        acct.revoke();
    }

    // ---------- session key rotation ----------

    function test_setSessionKey_rotation_oldKeyRefused_newKeyWorks() public {
        address newKey = makeAddr("newSession");
        vm.prank(owner);
        acct.setSessionKey(newKey);

        vm.prank(session);
        vm.expectRevert(LeashAccount.NotSessionKey.selector);
        acct.execute(dest, 0.1 ether, "");

        vm.prank(newKey);
        acct.execute(dest, 0.1 ether, "");
        assertEq(acct.spentInWindow(), 0.1 ether);
    }

    function test_setSessionKey_onlyOwner_rejectsZero() public {
        vm.prank(rando);
        vm.expectRevert(LeashAccount.NotOwner.selector);
        acct.setSessionKey(rando);
        vm.prank(session);
        vm.expectRevert(LeashAccount.NotOwner.selector);
        acct.setSessionKey(rando);
        vm.prank(owner);
        vm.expectRevert(LeashAccount.ZeroAddress.selector);
        acct.setSessionKey(address(0));
    }

    // ---------- guardian limits (H-02) ----------

    function test_guardian_cannotWithdrawOrChangePolicyOrRearmOrRotate() public {
        LeashAccount.Policy memory p = _policy();
        vm.startPrank(guardian);
        vm.expectRevert(LeashAccount.NotOwner.selector);
        acct.tightenPolicy(p);
        vm.expectRevert(LeashAccount.NotOwner.selector);
        acct.proposePolicy(p);
        vm.expectRevert(LeashAccount.NotOwner.selector);
        acct.proposeWithdraw(guardian, 1 ether);
        vm.expectRevert(LeashAccount.NotOwner.selector);
        acct.proposeAllowlist(guardian);
        vm.expectRevert(LeashAccount.NotOwner.selector);
        acct.removeAllowlist(dest);
        vm.expectRevert(LeashAccount.NotOwner.selector);
        acct.setSessionKey(guardian);
        vm.expectRevert(LeashAccount.NotOwner.selector);
        acct.setGuardian(guardian);
        vm.stopPrank();
    }

    function test_setGuardian_ownerCanReplaceOrRemove() public {
        address g2 = makeAddr("g2");
        vm.prank(owner);
        acct.setGuardian(g2);
        assertEq(acct.guardian(), g2);

        vm.prank(guardian); // old guardian lost the role
        vm.expectRevert(LeashAccount.NotGuardianOrOwner.selector);
        acct.revoke();

        vm.prank(g2);
        acct.revoke();
        assertTrue(acct.revoked());

        // removal (address(0) = no guardian)
        vm.prank(owner);
        acct.setGuardian(address(0));
        assertEq(acct.guardian(), address(0));
    }

    // ---------- asymmetric timelock: tightening instant ----------

    function test_tightenPolicy_instant() public {
        LeashAccount.Policy memory p = _policy();
        p.perTransferCap = 0.5 ether;
        p.windowCap = 1 ether;
        vm.prank(owner);
        acct.tightenPolicy(p);
        (uint128 ptc, uint128 wc,,) = acct.policy();
        assertEq(ptc, 0.5 ether);
        assertEq(wc, 1 ether);

        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccount.OverPerTransferCap.selector, 0.6 ether, 0.5 ether));
        acct.execute(dest, 0.6 ether, "");
    }

    function test_tightenPolicy_rejectsAnyLooseningComponent() public {
        LeashAccount.Policy memory p = _policy();
        p.perTransferCap = 2 ether; // raise = loosening
        vm.prank(owner);
        vm.expectRevert(LeashAccount.NotTightening.selector);
        acct.tightenPolicy(p);

        p = _policy();
        p.windowSeconds = WINDOW_SECONDS - 1; // shorter window = loosening
        vm.prank(owner);
        vm.expectRevert(LeashAccount.NotTightening.selector);
        acct.tightenPolicy(p);

        p = _policy();
        p.expiresAt = p.expiresAt + 1; // extend expiry = loosening
        vm.prank(owner);
        vm.expectRevert(LeashAccount.NotTightening.selector);
        acct.tightenPolicy(p);
    }

    // ---------- asymmetric timelock: loosening delayed ----------

    function test_proposePolicy_looseningBlockedBeforeDelay_appliedAfter() public {
        LeashAccount.Policy memory p = _policy();
        p.perTransferCap = 2 ether;

        vm.prank(owner);
        acct.proposePolicy(p);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(LeashAccount.TimelockNotElapsed.selector, uint64(block.timestamp + DELAY))
        );
        acct.applyPolicy();

        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applyPolicy();
        (uint128 ptc,,,) = acct.policy();
        assertEq(ptc, 2 ether);
    }

    function test_proposePolicy_rejectsPureTightening() public {
        // tightening must use the instant path, not clutter the queue
        LeashAccount.Policy memory p = _policy();
        p.perTransferCap = 0.5 ether;
        vm.prank(owner);
        vm.expectRevert(LeashAccount.NotLoosening.selector);
        acct.proposePolicy(p);
    }

    // ---------- adversarial timelock-queue semantics (carried review note) ----------

    function test_proposePolicy_reproposeOverwritesAndResetsEta() public {
        LeashAccount.Policy memory p1 = _policy();
        p1.perTransferCap = 2 ether;
        vm.prank(owner);
        acct.proposePolicy(p1);

        // half the delay passes, then owner re-proposes something looser
        vm.warp(block.timestamp + DELAY / 2);
        LeashAccount.Policy memory p2 = _policy();
        p2.perTransferCap = 10 ether;
        vm.prank(owner);
        acct.proposePolicy(p2);
        uint64 eta2 = uint64(block.timestamp + DELAY);

        // old eta must NOT unlock the new value
        vm.warp(block.timestamp + DELAY / 2); // = original eta
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(LeashAccount.TimelockNotElapsed.selector, eta2));
        acct.applyPolicy();

        // full new delay elapses → the NEW value (not the old one) applies
        vm.warp(eta2);
        vm.prank(owner);
        acct.applyPolicy();
        (uint128 ptc,,,) = acct.policy();
        assertEq(ptc, 10 ether);
    }

    function test_applyPolicy_clearsPending_noDoubleApply() public {
        LeashAccount.Policy memory p = _policy();
        p.perTransferCap = 2 ether;
        vm.prank(owner);
        acct.proposePolicy(p);
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applyPolicy();

        vm.prank(owner);
        vm.expectRevert(LeashAccount.NothingPending.selector);
        acct.applyPolicy();
    }

    function test_applyPolicy_nothingPendingReverts() public {
        vm.prank(owner);
        vm.expectRevert(LeashAccount.NothingPending.selector);
        acct.applyPolicy();
    }

    function test_proposeAllowlist_reproposeOverwrites_appliesLatestOnly() public {
        address a1 = makeAddr("a1");
        address a2 = makeAddr("a2");
        vm.prank(owner);
        acct.proposeAllowlist(a1);
        vm.warp(block.timestamp + DELAY / 2);
        vm.prank(owner);
        acct.proposeAllowlist(a2); // overwrites a1, resets eta

        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applyAllowlist();
        assertFalse(acct.allowlist(a1)); // a1 must NOT have been smuggled in
        assertTrue(acct.allowlist(a2));

        vm.prank(owner);
        vm.expectRevert(LeashAccount.NothingPending.selector);
        acct.applyAllowlist();
    }

    function test_allowlistAdd_blockedBeforeDelay() public {
        address a1 = makeAddr("a1");
        vm.prank(owner);
        acct.proposeAllowlist(a1);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(LeashAccount.TimelockNotElapsed.selector, uint64(block.timestamp + DELAY))
        );
        acct.applyAllowlist();
    }

    function test_removeAllowlist_instant() public {
        vm.prank(owner);
        acct.removeAllowlist(dest);
        assertFalse(acct.allowlist(dest));
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccount.NotAllowlisted.selector, dest));
        acct.execute(dest, 0.1 ether, "");
    }

    function test_withdraw_timelocked_ownerOnly_reproposeOverwrites() public {
        address payout = makeAddr("payout");
        vm.prank(owner);
        acct.proposeWithdraw(payout, 5 ether);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(LeashAccount.TimelockNotElapsed.selector, uint64(block.timestamp + DELAY))
        );
        acct.applyWithdraw();

        // re-propose a different amount; eta resets, old proposal gone
        vm.warp(block.timestamp + DELAY / 2);
        vm.prank(owner);
        acct.proposeWithdraw(payout, 7 ether);
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applyWithdraw();
        assertEq(payout.balance, 7 ether);

        vm.prank(owner);
        vm.expectRevert(LeashAccount.NothingPending.selector);
        acct.applyWithdraw();
    }

    function test_withdraw_worksEvenWhenRevoked() public {
        // owner must always be able to exit funds (escape hatch)
        address payout = makeAddr("payout");
        vm.prank(guardian);
        acct.revoke();
        vm.prank(owner);
        acct.proposeWithdraw(payout, 1 ether);
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applyWithdraw();
        assertEq(payout.balance, 1 ether);
    }

    // ---------- L-05: revoke / tightenPolicy clear pending timelocks ----------

    function _proposeAllThree() internal {
        LeashAccount.Policy memory p = _policy();
        p.perTransferCap = 2 ether; // loosening
        vm.startPrank(owner);
        acct.proposePolicy(p);
        acct.proposeAllowlist(rando);
        acct.proposeWithdraw(rando, 1 ether);
        vm.stopPrank();
    }

    function test_revoke_clearsPendingPolicy() public {
        _proposeAllThree();
        vm.prank(guardian);
        acct.revoke();
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert(LeashAccount.NothingPending.selector);
        acct.applyPolicy();
    }

    function test_revoke_clearsPendingAllowlist() public {
        _proposeAllThree();
        vm.prank(guardian);
        acct.revoke();
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert(LeashAccount.NothingPending.selector);
        acct.applyAllowlist();
        assertFalse(acct.allowlist(rando));
    }

    function test_revoke_clearsPendingWithdraw() public {
        _proposeAllThree();
        vm.prank(guardian);
        acct.revoke();
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert(LeashAccount.NothingPending.selector);
        acct.applyWithdraw();
        assertEq(rando.balance, 0);
    }

    function test_tightenPolicy_clearsPendingPolicy() public {
        _proposeAllThree();
        LeashAccount.Policy memory tighter = _policy();
        tighter.perTransferCap = 0.5 ether;
        vm.prank(owner);
        acct.tightenPolicy(tighter);
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert(LeashAccount.NothingPending.selector);
        acct.applyPolicy();
        (uint128 ptc,,,) = acct.policy();
        assertEq(ptc, 0.5 ether); // matured loosening did NOT survive the tighten
    }

    function test_tightenPolicy_clearsPendingAllowlist() public {
        _proposeAllThree();
        LeashAccount.Policy memory tighter = _policy();
        tighter.windowCap = 2 ether;
        vm.prank(owner);
        acct.tightenPolicy(tighter);
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert(LeashAccount.NothingPending.selector);
        acct.applyAllowlist();
        assertFalse(acct.allowlist(rando));
    }

    function test_tightenPolicy_clearsPendingWithdraw() public {
        _proposeAllThree();
        LeashAccount.Policy memory tighter = _policy();
        tighter.perTransferCap = 0.5 ether;
        vm.prank(owner);
        acct.tightenPolicy(tighter);
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert(LeashAccount.NothingPending.selector);
        acct.applyWithdraw();
        assertEq(rando.balance, 0);
    }

    // ---------- fuzz ----------

    function testFuzz_execute_neverExceedsCaps(uint96 amount) public {
        vm.assume(amount > 0);
        vm.prank(session);
        if (amount > PER_TX_CAP) {
            vm.expectRevert(abi.encodeWithSelector(LeashAccount.OverPerTransferCap.selector, amount, PER_TX_CAP));
            acct.execute(dest, amount, "");
        } else {
            acct.execute(dest, amount, "");
            assertLe(acct.spentInWindow(), WINDOW_CAP);
        }
    }

    function testFuzz_windowAccounting(uint64 a, uint64 b, uint32 gap) public {
        uint256 amtA = (uint256(a) % PER_TX_CAP) + 1;
        uint256 amtB = (uint256(b) % PER_TX_CAP) + 1;
        vm.prank(session);
        acct.execute(dest, amtA, "");
        vm.warp(block.timestamp + (gap % (2 * WINDOW_SECONDS)));
        vm.prank(session);
        uint256 startNew = block.timestamp;
        // compute expectation: window reset iff gap >= WINDOW_SECONDS
        bool reset = gap % (2 * WINDOW_SECONDS) >= WINDOW_SECONDS;
        uint256 expected = reset ? amtB : amtA + amtB;
        if (expected > WINDOW_CAP) {
            vm.expectRevert(abi.encodeWithSelector(LeashAccount.OverWindowCap.selector, expected, WINDOW_CAP));
            acct.execute(dest, amtB, "");
        } else {
            acct.execute(dest, amtB, "");
            assertEq(acct.spentInWindow(), expected);
        }
        startNew; // silence
    }
}
