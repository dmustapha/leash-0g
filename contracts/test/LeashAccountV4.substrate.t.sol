// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {LeashAccountV4} from "../src/LeashAccountV4.sol";
import {MockERC20} from "../src/MockERC20.sol";
import {MockRouter} from "../src/MockRouter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// D-15 substrate-parity + wall-branch-fill: ports the v3 legacy paths (execute /
/// executeTokenTransfer / native+token policy / allowlist / withdraw / roles /
/// revoke / constructor) onto LeashAccountV4 so the coverage number reflects the
/// WHOLE contract, and fills the remaining `executeCall` wall branches the primary
/// suite left uncovered (transferFrom recipient-allowlist mode, setApprovalForAll
/// spender check, decode-length variants, one-shot structural guards, empty-code /
/// codehash / self-call / zero-addr guards). Legacy behavior must be byte-for-byte
/// identical to v3 (F9 mixed-support).
contract LeashAccountV4SubstrateTest is Test {
    LeashAccountV4 internal acct;
    MockERC20 internal usd;
    MockRouter internal router;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal session = makeAddr("session");
    address internal dest = makeAddr("beneficiary");
    address internal rando = makeAddr("rando");
    address internal spender = makeAddr("spender");

    uint128 constant PER_TX_CAP = 1 ether;
    uint128 constant WINDOW_CAP = 3 ether;
    uint32 constant WINDOW_SECONDS = 1 hours;
    uint64 constant DELAY = 15 minutes;

    bytes4 constant SEL_APPROVE = 0x095ea7b3;
    bytes4 constant SEL_TRANSFER = 0xa9059cbb;
    bytes4 constant SEL_TRANSFER_FROM = 0x23b872dd;
    bytes4 constant SEL_SET_APPROVAL_FOR_ALL = 0xa22cb465;

    function _policy() internal view returns (LeashAccountV4.Policy memory) {
        return LeashAccountV4.Policy({
            perTransferCap: PER_TX_CAP,
            windowCap: WINDOW_CAP,
            windowSeconds: WINDOW_SECONDS,
            expiresAt: uint64(block.timestamp + 30 days)
        });
    }

    function setUp() public {
        vm.warp(1_700_000_000);
        usd = new MockERC20("Test USD", "TestUSD", 6);
        router = new MockRouter();
        address[] memory list = new address[](1);
        list[0] = dest;
        acct = new LeashAccountV4(
            owner, guardian, session, _policy(), list, DELAY, address(usd), LeashAccountV4.TokenPolicy(100e6, 250e6)
        );
        usd.mint(address(acct), 1_000e6);
        vm.deal(address(acct), 100 ether);
    }

    // ================= constructor branches =================

    function test_ctor_revertsZeroOwner() public {
        address[] memory list = new address[](0);
        vm.expectRevert(LeashAccountV4.ZeroAddress.selector);
        new LeashAccountV4(
            address(0), guardian, session, _policy(), list, DELAY, address(0), LeashAccountV4.TokenPolicy(0, 0)
        );
    }

    function test_ctor_revertsZeroSession() public {
        address[] memory list = new address[](0);
        vm.expectRevert(LeashAccountV4.ZeroAddress.selector);
        new LeashAccountV4(
            owner, guardian, address(0), _policy(), list, DELAY, address(0), LeashAccountV4.TokenPolicy(0, 0)
        );
    }

    function test_ctor_revertsZeroWindow() public {
        address[] memory list = new address[](0);
        LeashAccountV4.Policy memory p = _policy();
        p.windowSeconds = 0;
        vm.expectRevert(LeashAccountV4.InvalidPolicy.selector);
        new LeashAccountV4(owner, guardian, session, p, list, DELAY, address(0), LeashAccountV4.TokenPolicy(0, 0));
    }

    function test_ctor_revertsZeroInAllowlist() public {
        address[] memory list = new address[](1);
        list[0] = address(0);
        vm.expectRevert(LeashAccountV4.ZeroAddress.selector);
        new LeashAccountV4(
            owner, guardian, session, _policy(), list, DELAY, address(0), LeashAccountV4.TokenPolicy(0, 0)
        );
    }

    function test_ctor_nativeOnly_noSettlementToken() public {
        address[] memory list = new address[](0);
        LeashAccountV4 a = new LeashAccountV4(
            owner, guardian, session, _policy(), list, DELAY, address(0), LeashAccountV4.TokenPolicy(0, 0)
        );
        assertEq(a.settlementToken(), address(0));
    }

    // ================= receive =================

    function test_receive_acceptsDeposits() public {
        vm.deal(rando, 5 ether);
        vm.prank(rando);
        (bool ok,) = address(acct).call{value: 2 ether}("");
        assertTrue(ok);
        assertEq(address(acct).balance, 102 ether);
    }

    // ================= native execute (legacy path unchanged) =================

    function test_execute_happy() public {
        vm.prank(session);
        acct.execute(dest, 1 ether, "");
        assertEq(dest.balance, 1 ether);
        assertEq(acct.spentInWindow(), 1 ether);
    }

    function test_execute_notSessionKey_reverts() public {
        vm.prank(rando);
        vm.expectRevert(LeashAccountV4.NotSessionKey.selector);
        acct.execute(dest, 1 ether, "");
    }

    function test_execute_revoked_reverts() public {
        vm.prank(owner);
        acct.revoke();
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.AccountRevoked.selector);
        acct.execute(dest, 1 ether, "");
    }

    function test_execute_expired_reverts() public {
        vm.warp(block.timestamp + 31 days);
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.SessionExpired.selector);
        acct.execute(dest, 1 ether, "");
    }

    function test_execute_zeroTo_reverts() public {
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.ZeroAddress.selector);
        acct.execute(address(0), 1 ether, "");
    }

    function test_execute_offAllowlist_reverts() public {
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.NotAllowlisted.selector, rando));
        acct.execute(rando, 1 ether, "");
    }

    function test_execute_withCalldata_stillForbidden() public {
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.CalldataForbidden.selector);
        acct.execute(dest, 0, hex"deadbeef");
    }

    function test_execute_overPerTransferCap_reverts() public {
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.OverPerTransferCap.selector, 2 ether, PER_TX_CAP));
        acct.execute(dest, 2 ether, "");
    }

    function test_execute_overWindowCap_reverts() public {
        vm.startPrank(session);
        acct.execute(dest, 1 ether, "");
        acct.execute(dest, 1 ether, "");
        acct.execute(dest, 1 ether, "");
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.OverWindowCap.selector, 4 ether, WINDOW_CAP));
        acct.execute(dest, 1 ether, "");
        vm.stopPrank();
    }

    function test_execute_windowRollsOver() public {
        vm.startPrank(session);
        acct.execute(dest, 1 ether, "");
        vm.warp(block.timestamp + WINDOW_SECONDS + 1);
        acct.execute(dest, 1 ether, "");
        vm.stopPrank();
        assertEq(acct.spentInWindow(), 1 ether);
    }

    function test_execute_callFailsToReverter_reverts() public {
        Reverter r = new Reverter();
        vm.prank(owner);
        acct.proposeAllowlist(address(r));
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applyAllowlist();
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.CallFailed.selector);
        acct.execute(address(r), 1 ether, "");
    }

    // ================= executeTokenTransfer (legacy path unchanged) =================

    function test_tokenTransfer_happy() public {
        vm.prank(session);
        acct.executeTokenTransfer(address(usd), dest, 50e6);
        assertEq(usd.balanceOf(dest), 50e6);
    }

    function test_tokenTransfer_notSession_reverts() public {
        vm.prank(rando);
        vm.expectRevert(LeashAccountV4.NotSessionKey.selector);
        acct.executeTokenTransfer(address(usd), dest, 50e6);
    }

    function test_tokenTransfer_revoked_reverts() public {
        vm.prank(guardian);
        acct.revoke();
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.AccountRevoked.selector);
        acct.executeTokenTransfer(address(usd), dest, 50e6);
    }

    function test_tokenTransfer_expired_reverts() public {
        vm.warp(block.timestamp + 31 days);
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.SessionExpired.selector);
        acct.executeTokenTransfer(address(usd), dest, 50e6);
    }

    function test_tokenTransfer_zeroTo_reverts() public {
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.ZeroAddress.selector);
        acct.executeTokenTransfer(address(usd), address(0), 50e6);
    }

    function test_tokenTransfer_wrongToken_reverts() public {
        MockERC20 other = new MockERC20("Other", "OTH", 6);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.TokenNotAllowlisted.selector, address(other)));
        acct.executeTokenTransfer(address(other), dest, 50e6);
    }

    function test_tokenTransfer_offAllowlistRecipient_reverts() public {
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.NotAllowlisted.selector, rando));
        acct.executeTokenTransfer(address(usd), rando, 50e6);
    }

    function test_tokenTransfer_overPerTransferCap_reverts() public {
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.OverPerTransferCapToken.selector, 150e6, 100e6));
        acct.executeTokenTransfer(address(usd), dest, 150e6);
    }

    function test_tokenTransfer_overWindowCap_reverts() public {
        vm.startPrank(session);
        acct.executeTokenTransfer(address(usd), dest, 100e6);
        acct.executeTokenTransfer(address(usd), dest, 100e6);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.OverWindowCapToken.selector, 260e6, 250e6));
        acct.executeTokenTransfer(address(usd), dest, 60e6);
        vm.stopPrank();
    }

    function test_tokenTransfer_windowRollsOver() public {
        vm.startPrank(session);
        acct.executeTokenTransfer(address(usd), dest, 100e6);
        vm.warp(block.timestamp + WINDOW_SECONDS + 1);
        acct.executeTokenTransfer(address(usd), dest, 100e6);
        vm.stopPrank();
        assertEq(acct.spentInWindowToken(), 100e6);
    }

    function test_tokenTransfer_noSettlementToken_reverts() public {
        address[] memory list = new address[](1);
        list[0] = dest;
        LeashAccountV4 a = new LeashAccountV4(
            owner, guardian, session, _policy(), list, DELAY, address(0), LeashAccountV4.TokenPolicy(0, 0)
        );
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.NoSettlementToken.selector);
        a.executeTokenTransfer(address(usd), dest, 1);
    }

    function test_tokenTransfer_fakeSuccessReturn_reverts() public {
        FakeTok f = new FakeTok();
        // settlement token is fixed at construction; deploy an account whose settlement is the fake
        address[] memory list = new address[](1);
        list[0] = dest;
        LeashAccountV4 a = new LeashAccountV4(
            owner, guardian, session, _policy(), list, DELAY, address(f), LeashAccountV4.TokenPolicy(100e6, 250e6)
        );
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.TokenTransferFailed.selector);
        a.executeTokenTransfer(address(f), dest, 1);
    }

    // ================= roles =================

    function test_setSessionKey_ownerOnly_rotates() public {
        address nk = makeAddr("nk");
        vm.prank(owner);
        acct.setSessionKey(nk);
        assertEq(acct.sessionKey(), nk);
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.NotSessionKey.selector);
        acct.execute(dest, 1 ether, "");
    }

    function test_setSessionKey_zero_reverts() public {
        vm.prank(owner);
        vm.expectRevert(LeashAccountV4.ZeroAddress.selector);
        acct.setSessionKey(address(0));
    }

    function test_setSessionKey_notOwner_reverts() public {
        vm.prank(rando);
        vm.expectRevert(LeashAccountV4.NotOwner.selector);
        acct.setSessionKey(rando);
    }

    function test_setGuardian_ownerCanReplaceOrRemove() public {
        vm.prank(owner);
        acct.setGuardian(rando);
        assertEq(acct.guardian(), rando);
        vm.prank(owner);
        acct.setGuardian(address(0));
        assertEq(acct.guardian(), address(0));
    }

    // ================= native policy timelock =================

    function test_tightenPolicy_instant() public {
        LeashAccountV4.Policy memory p = _policy();
        p.perTransferCap = 0.5 ether;
        vm.prank(owner);
        acct.tightenPolicy(p);
        (uint128 cap,,,) = acct.policy();
        assertEq(cap, 0.5 ether);
    }

    function test_tightenPolicy_zeroWindow_reverts() public {
        LeashAccountV4.Policy memory p = _policy();
        p.windowSeconds = 0;
        vm.prank(owner);
        vm.expectRevert(LeashAccountV4.InvalidPolicy.selector);
        acct.tightenPolicy(p);
    }

    function test_tightenPolicy_loosening_reverts() public {
        LeashAccountV4.Policy memory p = _policy();
        p.perTransferCap = 2 ether;
        vm.prank(owner);
        vm.expectRevert(LeashAccountV4.NotTightening.selector);
        acct.tightenPolicy(p);
    }

    function test_proposePolicy_zeroWindow_reverts() public {
        LeashAccountV4.Policy memory p = _policy();
        p.windowSeconds = 0;
        vm.prank(owner);
        vm.expectRevert(LeashAccountV4.InvalidPolicy.selector);
        acct.proposePolicy(p);
    }

    function test_proposePolicy_notLoosening_reverts() public {
        LeashAccountV4.Policy memory p = _policy();
        p.perTransferCap = 0.5 ether;
        vm.prank(owner);
        vm.expectRevert(LeashAccountV4.NotLoosening.selector);
        acct.proposePolicy(p);
    }

    function test_policy_proposeWaitApply() public {
        LeashAccountV4.Policy memory p = _policy();
        p.perTransferCap = 2 ether;
        vm.prank(owner);
        acct.proposePolicy(p);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.TimelockNotElapsed.selector, block.timestamp + DELAY));
        acct.applyPolicy();
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applyPolicy();
        (uint128 cap,,,) = acct.policy();
        assertEq(cap, 2 ether);
    }

    function test_applyPolicy_nothingPending_reverts() public {
        vm.prank(owner);
        vm.expectRevert(LeashAccountV4.NothingPending.selector);
        acct.applyPolicy();
    }

    // ================= token policy timelock =================

    function test_tightenTokenPolicy_instant() public {
        vm.prank(owner);
        acct.tightenTokenPolicy(LeashAccountV4.TokenPolicy(50e6, 100e6));
        (uint128 cap,) = acct.tokenPolicy();
        assertEq(cap, 50e6);
    }

    function test_tightenTokenPolicy_loosening_reverts() public {
        vm.prank(owner);
        vm.expectRevert(LeashAccountV4.NotTightening.selector);
        acct.tightenTokenPolicy(LeashAccountV4.TokenPolicy(200e6, 300e6));
    }

    function test_tokenPolicy_proposeWaitApply() public {
        vm.prank(owner);
        acct.proposeTokenPolicy(LeashAccountV4.TokenPolicy(200e6, 400e6));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.TimelockNotElapsed.selector, block.timestamp + DELAY));
        acct.applyTokenPolicy();
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applyTokenPolicy();
        (uint128 cap,) = acct.tokenPolicy();
        assertEq(cap, 200e6);
    }

    function test_proposeTokenPolicy_notLoosening_reverts() public {
        vm.prank(owner);
        vm.expectRevert(LeashAccountV4.NotLoosening.selector);
        acct.proposeTokenPolicy(LeashAccountV4.TokenPolicy(50e6, 100e6));
    }

    function test_applyTokenPolicy_nothingPending_reverts() public {
        vm.prank(owner);
        vm.expectRevert(LeashAccountV4.NothingPending.selector);
        acct.applyTokenPolicy();
    }

    function test_tokenPolicy_noSettlement_reverts() public {
        address[] memory list = new address[](0);
        LeashAccountV4 a = new LeashAccountV4(
            owner, guardian, session, _policy(), list, DELAY, address(0), LeashAccountV4.TokenPolicy(0, 0)
        );
        vm.prank(owner);
        vm.expectRevert(LeashAccountV4.NoSettlementToken.selector);
        a.tightenTokenPolicy(LeashAccountV4.TokenPolicy(1, 1));
        vm.prank(owner);
        vm.expectRevert(LeashAccountV4.NoSettlementToken.selector);
        a.proposeTokenPolicy(LeashAccountV4.TokenPolicy(1, 1));
    }

    // ================= allowlist timelock =================

    function test_allowlist_proposeWaitApply() public {
        vm.prank(owner);
        acct.proposeAllowlist(rando);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.TimelockNotElapsed.selector, block.timestamp + DELAY));
        acct.applyAllowlist();
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applyAllowlist();
        assertTrue(acct.allowlist(rando));
    }

    function test_proposeAllowlist_zero_reverts() public {
        vm.prank(owner);
        vm.expectRevert(LeashAccountV4.ZeroAddress.selector);
        acct.proposeAllowlist(address(0));
    }

    function test_applyAllowlist_nothingPending_reverts() public {
        vm.prank(owner);
        vm.expectRevert(LeashAccountV4.NothingPending.selector);
        acct.applyAllowlist();
    }

    function test_removeAllowlist_instant() public {
        vm.prank(owner);
        acct.removeAllowlist(dest);
        assertFalse(acct.allowlist(dest));
    }

    // ================= withdraw timelock =================

    function test_withdraw_proposeWaitApply() public {
        vm.prank(owner);
        acct.proposeWithdraw(owner, 5 ether);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.TimelockNotElapsed.selector, block.timestamp + DELAY));
        acct.applyWithdraw();
        vm.warp(block.timestamp + DELAY);
        uint256 before = owner.balance;
        vm.prank(owner);
        acct.applyWithdraw();
        assertEq(owner.balance, before + 5 ether);
    }

    function test_proposeWithdraw_zero_reverts() public {
        vm.prank(owner);
        vm.expectRevert(LeashAccountV4.ZeroAddress.selector);
        acct.proposeWithdraw(address(0), 1 ether);
    }

    function test_applyWithdraw_nothingPending_reverts() public {
        vm.prank(owner);
        vm.expectRevert(LeashAccountV4.NothingPending.selector);
        acct.applyWithdraw();
    }

    function test_withdraw_toReverter_reverts() public {
        Reverter r = new Reverter();
        vm.prank(owner);
        acct.proposeWithdraw(address(r), 1 ether);
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert(LeashAccountV4.CallFailed.selector);
        acct.applyWithdraw();
    }

    function test_withdraw_worksEvenWhenRevoked() public {
        vm.prank(owner);
        acct.revoke();
        vm.prank(owner);
        acct.proposeWithdraw(owner, 1 ether);
        vm.warp(block.timestamp + DELAY);
        uint256 before = owner.balance;
        vm.prank(owner);
        acct.applyWithdraw();
        assertEq(owner.balance, before + 1 ether);
    }

    // ================= revoke / rearm =================

    function test_revoke_byGuardian_thenRearmByOwnerOnly() public {
        vm.prank(guardian);
        acct.revoke();
        assertTrue(acct.revoked());
        vm.prank(guardian);
        vm.expectRevert(LeashAccountV4.NotOwner.selector);
        acct.rearm();
        vm.prank(owner);
        acct.rearm();
        assertFalse(acct.revoked());
    }

    function test_revoke_byRando_reverts() public {
        vm.prank(rando);
        vm.expectRevert(LeashAccountV4.NotGuardianOrOwner.selector);
        acct.revoke();
    }

    function test_rearm_whenNotRevoked_reverts() public {
        vm.prank(owner);
        vm.expectRevert(LeashAccountV4.AccountNotRevoked.selector);
        acct.rearm();
    }

    // ================= executeCall wall-branch fill =================

    function _grantBudget(address token, uint128 cap) internal {
        vm.prank(owner);
        acct.proposeSpendBudget(token, cap);
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applySpendBudget();
    }

    function _grantRule(
        address target,
        bytes4 selector,
        uint8 recipientMode,
        address sp,
        uint128 perCallCap,
        uint128 windowCapCall
    ) internal {
        address[] memory s = new address[](1);
        s[0] = sp;
        vm.prank(owner);
        acct.proposeCallRule(target, selector, recipientMode, s, perCallCap, windowCapCall, bytes32(0));
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applyCallRule();
    }

    function test_executeCall_selfCall_reverts() public {
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.SelfCallForbidden.selector);
        acct.executeCall(address(acct), 0, abi.encodeWithSelector(SEL_APPROVE, spender, 1));
    }

    function test_executeCall_zeroTarget_reverts() public {
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.ZeroAddress.selector);
        acct.executeCall(address(0), 0, abi.encodeWithSelector(SEL_APPROVE, spender, 1));
    }

    function test_executeCall_shortData_reverts() public {
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.DecodeMismatch.selector);
        acct.executeCall(address(usd), 0, hex"0011");
    }

    function test_executeCall_emptyCodeTarget_reverts() public {
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.EmptyCodeTarget.selector, rando));
        acct.executeCall(rando, 0, abi.encodeWithSelector(SEL_APPROVE, spender, 1));
    }

    function test_executeCall_notSession_reverts() public {
        vm.prank(rando);
        vm.expectRevert(LeashAccountV4.NotSessionKey.selector);
        acct.executeCall(address(usd), 0, abi.encodeWithSelector(SEL_APPROVE, spender, 1));
    }

    function test_executeCall_revoked_reverts() public {
        vm.prank(owner);
        acct.revoke();
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.AccountRevoked.selector);
        acct.executeCall(address(usd), 0, abi.encodeWithSelector(SEL_APPROVE, spender, 1));
    }

    function test_executeCall_expired_reverts() public {
        vm.warp(block.timestamp + 31 days);
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.SessionExpired.selector);
        acct.executeCall(address(usd), 0, abi.encodeWithSelector(SEL_APPROVE, spender, 1));
    }

    function test_transferFrom_selfToAllowlisted_mode1_succeeds() public {
        _grantBudget(address(usd), 500e6);
        _grantRule(address(usd), SEL_TRANSFER_FROM, 1, spender, 200e6, 400e6);
        // account approves itself as spender in the token (so transferFrom(self→dest) works)
        vm.prank(address(acct));
        usd.approve(address(acct), type(uint256).max);
        bytes memory data = abi.encodeWithSelector(SEL_TRANSFER_FROM, address(acct), dest, 100e6);
        vm.prank(session);
        acct.executeCall(address(usd), 0, data);
        assertEq(usd.balanceOf(dest), 100e6);
    }

    function test_setApprovalForAll_spenderNotAllowlisted_reverts() public {
        _grantRule(address(usd), SEL_SET_APPROVAL_FOR_ALL, 0, spender, 0, 0);
        bytes memory data = abi.encodeWithSelector(SEL_SET_APPROVAL_FOR_ALL, rando, false);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.SpenderNotAllowlisted.selector, rando));
        acct.executeCall(address(usd), 0, data);
    }

    function test_approve_badLength_reverts() public {
        _grantBudget(address(usd), 500e6);
        _grantRule(address(usd), SEL_APPROVE, 0, address(router), 200e6, 400e6);
        // approve selector but with only one arg word (wrong length)
        bytes memory data = abi.encodePacked(SEL_APPROVE, bytes32(uint256(uint160(address(router)))));
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.DecodeMismatch.selector);
        acct.executeCall(address(usd), 0, data);
    }

    function test_transferFrom_badLength_reverts() public {
        _grantBudget(address(usd), 500e6);
        _grantRule(address(usd), SEL_TRANSFER_FROM, 0, spender, 200e6, 400e6);
        // transferFrom selector with only 2 words instead of 3
        bytes memory data =
            abi.encodePacked(SEL_TRANSFER_FROM, bytes32(uint256(uint160(address(acct)))), bytes32(uint256(uint160(dest))));
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.DecodeMismatch.selector);
        acct.executeCall(address(usd), 0, data);
    }

    function test_setApprovalForAll_badLength_reverts() public {
        _grantRule(address(usd), SEL_SET_APPROVAL_FOR_ALL, 0, spender, 0, 0);
        bytes memory data = abi.encodePacked(SEL_SET_APPROVAL_FOR_ALL, bytes32(uint256(uint160(spender))));
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.DecodeMismatch.selector);
        acct.executeCall(address(usd), 0, data);
    }

    function test_oneShot_boolReturningSelector_fakeSuccess_reverts() public {
        FakeTok f = new FakeTok();
        bytes memory data = abi.encodeWithSelector(SEL_TRANSFER, dest, 1);
        bytes32 h = keccak256(abi.encode(address(f), SEL_TRANSFER, data, uint256(0)));
        vm.prank(owner);
        acct.authorizeOnce(h, uint64(block.timestamp + 1 hours));
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.TokenTransferFailed.selector);
        acct.executeCall(address(f), 0, data);
    }

    function test_oneShot_callFails_reverts() public {
        Reverter r = new Reverter();
        bytes memory data = abi.encodeWithSelector(bytes4(0xdeadbeef));
        bytes32 h = keccak256(abi.encode(address(r), bytes4(0xdeadbeef), data, uint256(0)));
        vm.prank(owner);
        acct.authorizeOnce(h, uint64(block.timestamp + 1 hours));
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.CallFailed.selector);
        acct.executeCall(address(r), 0, data);
    }

    // one-shot transferFrom exercises the transferFrom arm of _isBoolReturningSelector
    function test_oneShot_transferFrom_boolCheck_succeeds() public {
        vm.prank(address(acct));
        usd.approve(address(acct), type(uint256).max);
        bytes memory data = abi.encodeWithSelector(SEL_TRANSFER_FROM, address(acct), dest, 10e6);
        bytes32 h = keccak256(abi.encode(address(usd), SEL_TRANSFER_FROM, data, uint256(0)));
        vm.prank(owner);
        acct.authorizeOnce(h, uint64(block.timestamp + 1 hours));
        vm.prank(session);
        acct.executeCall(address(usd), 0, data);
        assertEq(usd.balanceOf(dest), 10e6);
    }

    // ================= grant-surface revert branches =================

    function test_proposeCallRule_notOwner_reverts() public {
        address[] memory s = new address[](0);
        vm.prank(rando);
        vm.expectRevert(LeashAccountV4.NotOwner.selector);
        acct.proposeCallRule(address(usd), SEL_APPROVE, 0, s, 1, 1, bytes32(0));
    }

    function test_proposeCallRule_zeroTarget_reverts() public {
        address[] memory s = new address[](0);
        vm.prank(owner);
        vm.expectRevert(LeashAccountV4.ZeroAddress.selector);
        acct.proposeCallRule(address(0), SEL_APPROVE, 0, s, 1, 1, bytes32(0));
    }

    function test_proposeCallRule_selfTarget_reverts() public {
        address[] memory s = new address[](0);
        vm.prank(owner);
        vm.expectRevert(LeashAccountV4.ZeroAddress.selector);
        acct.proposeCallRule(address(acct), SEL_APPROVE, 0, s, 1, 1, bytes32(0));
    }

    function test_proposeCallRule_badRecipientMode_reverts() public {
        address[] memory s = new address[](0);
        vm.prank(owner);
        vm.expectRevert(LeashAccountV4.InvalidPolicy.selector);
        acct.proposeCallRule(address(usd), SEL_APPROVE, 2, s, 1, 1, bytes32(0));
    }

    function test_proposeCallRule_zeroSpender_reverts() public {
        address[] memory s = new address[](1);
        s[0] = address(0);
        vm.prank(owner);
        vm.expectRevert(LeashAccountV4.ZeroAddress.selector);
        acct.proposeCallRule(address(usd), SEL_APPROVE, 0, s, 1, 1, bytes32(0));
    }

    function test_applyCallRule_nothingPending_reverts() public {
        vm.prank(owner);
        vm.expectRevert(LeashAccountV4.NothingPending.selector);
        acct.applyCallRule();
    }

    function test_tightenCallRule_unknownRule_reverts() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.SelectorNotAllowlisted.selector, SEL_APPROVE));
        acct.tightenCallRule(address(usd), SEL_APPROVE, 0, 0);
    }

    function test_applySpendBudget_nothingPending_reverts() public {
        vm.prank(owner);
        vm.expectRevert(LeashAccountV4.NothingPending.selector);
        acct.applySpendBudget();
    }

    function test_tightenSpendBudget_notSet_reverts() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.BudgetNotSet.selector, address(usd)));
        acct.tightenSpendBudget(address(usd), 1);
    }

    function test_authorizeOnce_pastExpiry_reverts() public {
        vm.prank(owner);
        vm.expectRevert(LeashAccountV4.OneShotExpired.selector);
        acct.authorizeOnce(bytes32(uint256(1)), uint64(block.timestamp));
    }
}

/// A contract that reverts on any call / native receive.
contract Reverter {
    fallback() external payable {
        revert("no");
    }
}

/// A token whose transfer returns false without reverting (fake-success, H-05).
contract FakeTok {
    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }
}
