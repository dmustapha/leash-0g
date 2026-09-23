// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {LeashAccount} from "../src/LeashAccount.sol";
import {MockERC20} from "../src/MockERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// A token whose `transfer` returns false without moving funds (non-reverting
/// failure) — the SafeERC20-style return check must catch this.
contract FalseReturningToken {
    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }
}

/// A token that reverts inside `transfer` — must surface as TokenTransferFailed.
contract RevertingToken {
    function transfer(address, uint256) external pure returns (bool) {
        revert("nope");
    }
}

/// A token that returns NOTHING (non-standard ERC-20, like early USDT) — the
/// return check treats empty returndata as success (ok && no returndata).
contract NoReturnToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function transfer(address to, uint256 amt) external {
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
    }
}

/// A malicious ERC-20 that re-enters `executeTokenTransfer` during `transfer`.
/// The ReentrancyGuard + CEI must prevent any double-spend.
contract ReentrantToken {
    LeashAccount public target;
    address public dest;
    bool public reentrySucceeded;
    bool private attacking;
    mapping(address => uint256) public balanceOf;

    function set(LeashAccount t, address d) external {
        target = t;
        dest = d;
    }

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        if (!attacking) {
            attacking = true;
            // Attempt to re-enter mid-call; MUST fail (nonReentrant).
            try target.executeTokenTransfer(address(this), dest, amt) {
                reentrySucceeded = true;
            } catch {}
            attacking = false;
        }
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }
}

contract LeashAccountTokenTest is Test {
    LeashAccount internal acct;
    MockERC20 internal usd;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal session = makeAddr("session");
    address internal dest = makeAddr("beneficiary");
    address internal rando = makeAddr("rando");

    uint128 constant PER_TX_CAP = 1 ether; // native
    uint128 constant WINDOW_CAP = 3 ether; // native
    uint128 constant TOKEN_PER_TX = 100e6; // 100 TestUSD (6dp)
    uint128 constant TOKEN_WINDOW = 250e6; // 250 TestUSD
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

    function _tp() internal pure returns (LeashAccount.TokenPolicy memory) {
        return LeashAccount.TokenPolicy({perTransferCapToken: TOKEN_PER_TX, windowCapToken: TOKEN_WINDOW});
    }

    function _deployToken(address token) internal returns (LeashAccount a) {
        address[] memory list = new address[](1);
        list[0] = dest;
        a = new LeashAccount(owner, guardian, session, _policy(), list, DELAY, token, _tp());
    }

    function setUp() public {
        vm.warp(1_700_000_000);
        usd = new MockERC20("Test USD", "TestUSD", 6);
        acct = _deployToken(address(usd));
        usd.mint(address(acct), 1_000e6);
        vm.deal(address(acct), 100 ether);
    }

    // ---------- construction ----------

    function test_constructor_setsTokenConfig() public view {
        assertEq(acct.settlementToken(), address(usd));
        (uint128 ptc, uint128 wc) = acct.tokenPolicy();
        assertEq(ptc, TOKEN_PER_TX);
        assertEq(wc, TOKEN_WINDOW);
        assertEq(acct.windowStartToken(), uint64(block.timestamp));
    }

    function test_nativeOnlyAccount_hasNoTokenConfig() public {
        address[] memory list = new address[](1);
        list[0] = dest;
        LeashAccount native = new LeashAccount(
            owner, guardian, session, _policy(), list, DELAY, address(0), LeashAccount.TokenPolicy(0, 0)
        );
        assertEq(native.settlementToken(), address(0));
        (uint128 ptc, uint128 wc) = native.tokenPolicy();
        assertEq(ptc, 0);
        assertEq(wc, 0);
    }

    // ---------- happy path ----------

    function test_executeToken_happyPath_movesFundsAndAccounts() public {
        vm.prank(session);
        acct.executeTokenTransfer(address(usd), dest, 40e6);
        assertEq(usd.balanceOf(dest), 40e6);
        assertEq(usd.balanceOf(address(acct)), 960e6);
        assertEq(acct.spentInWindowToken(), 40e6);
    }

    function test_executeToken_emitsTokenExecuted() public {
        vm.expectEmit(true, true, false, true);
        emit LeashAccount.TokenExecuted(address(usd), dest, 40e6, 40e6);
        vm.prank(session);
        acct.executeTokenTransfer(address(usd), dest, 40e6);
    }

    function test_executeToken_accumulatesWithinWindow() public {
        vm.startPrank(session);
        acct.executeTokenTransfer(address(usd), dest, 100e6);
        acct.executeTokenTransfer(address(usd), dest, 100e6);
        vm.stopPrank();
        assertEq(acct.spentInWindowToken(), 200e6);
    }

    function test_executeToken_atExactPerTransferCap_isAccepted() public {
        vm.prank(session);
        acct.executeTokenTransfer(address(usd), dest, TOKEN_PER_TX);
        assertEq(acct.spentInWindowToken(), TOKEN_PER_TX);
    }

    // ---------- forbidden actions REVERT ----------

    function test_executeToken_notSessionKey_reverts() public {
        vm.prank(rando);
        vm.expectRevert(LeashAccount.NotSessionKey.selector);
        acct.executeTokenTransfer(address(usd), dest, 10e6);
    }

    function test_executeToken_afterRevoke_reverts_failClosed() public {
        vm.prank(guardian);
        acct.revoke();
        vm.prank(session);
        vm.expectRevert(LeashAccount.AccountRevoked.selector);
        acct.executeTokenTransfer(address(usd), dest, 10e6);
    }

    function test_executeToken_afterExpiry_reverts() public {
        vm.warp(block.timestamp + 31 days);
        vm.prank(session);
        vm.expectRevert(LeashAccount.SessionExpired.selector);
        acct.executeTokenTransfer(address(usd), dest, 10e6);
    }

    function test_executeToken_zeroRecipient_reverts() public {
        vm.prank(session);
        vm.expectRevert(LeashAccount.ZeroAddress.selector);
        acct.executeTokenTransfer(address(usd), address(0), 10e6);
    }

    function test_executeToken_offTokenAllowlist_reverts() public {
        MockERC20 other = new MockERC20("Other", "OTH", 6);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccount.TokenNotAllowlisted.selector, address(other)));
        acct.executeTokenTransfer(address(other), dest, 10e6);
    }

    function test_executeToken_offRecipientAllowlist_reverts() public {
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccount.NotAllowlisted.selector, rando));
        acct.executeTokenTransfer(address(usd), rando, 10e6);
    }

    function test_executeToken_overPerTransferCap_reverts() public {
        vm.prank(session);
        vm.expectRevert(
            abi.encodeWithSelector(LeashAccount.OverPerTransferCapToken.selector, TOKEN_PER_TX + 1, TOKEN_PER_TX)
        );
        acct.executeTokenTransfer(address(usd), dest, TOKEN_PER_TX + 1);
    }

    function test_executeToken_overWindowCap_reverts() public {
        vm.startPrank(session);
        acct.executeTokenTransfer(address(usd), dest, 100e6);
        acct.executeTokenTransfer(address(usd), dest, 100e6);
        // 200 spent; a third 100 would attempt 300 > 250 windowCap
        vm.expectRevert(abi.encodeWithSelector(LeashAccount.OverWindowCapToken.selector, 300e6, TOKEN_WINDOW));
        acct.executeTokenTransfer(address(usd), dest, 100e6);
        vm.stopPrank();
    }

    function test_executeToken_onNativeOnlyAccount_reverts_noSettlementToken() public {
        address[] memory list = new address[](1);
        list[0] = dest;
        LeashAccount native = new LeashAccount(
            owner, guardian, session, _policy(), list, DELAY, address(0), LeashAccount.TokenPolicy(0, 0)
        );
        usd.mint(address(native), 100e6);
        vm.prank(session);
        vm.expectRevert(LeashAccount.NoSettlementToken.selector);
        native.executeTokenTransfer(address(usd), dest, 10e6);
    }

    // ---------- arbitrary calldata still impossible (D-JOB-6) ----------

    function test_nativeExecute_withData_stillReverts_calldataForbidden() public {
        vm.prank(session);
        vm.expectRevert(LeashAccount.CalldataForbidden.selector);
        acct.execute(dest, 0, hex"deadbeef");
    }

    // ---------- window rollover (tumbling, <=2x burst) ----------

    function test_executeToken_windowRollover_resetsCounter() public {
        vm.startPrank(session);
        acct.executeTokenTransfer(address(usd), dest, 100e6);
        assertEq(acct.spentInWindowToken(), 100e6);
        vm.warp(block.timestamp + WINDOW_SECONDS); // past boundary
        acct.executeTokenTransfer(address(usd), dest, 100e6);
        assertEq(acct.spentInWindowToken(), 100e6); // reset then this spend
        vm.stopPrank();
    }

    function test_executeToken_windowIsIndependentOfNative() public {
        vm.startPrank(session);
        acct.execute(dest, 1 ether, ""); // native spend
        acct.executeTokenTransfer(address(usd), dest, 100e6); // token spend
        vm.stopPrank();
        assertEq(acct.spentInWindow(), 1 ether);
        assertEq(acct.spentInWindowToken(), 100e6);
    }

    // ---------- malicious / non-standard tokens ----------

    function test_executeToken_falseReturningToken_reverts() public {
        FalseReturningToken bad = new FalseReturningToken();
        LeashAccount a = _deployToken(address(bad));
        vm.prank(session);
        vm.expectRevert(LeashAccount.TokenTransferFailed.selector);
        a.executeTokenTransfer(address(bad), dest, 10e6);
    }

    function test_executeToken_revertingToken_reverts() public {
        RevertingToken bad = new RevertingToken();
        LeashAccount a = _deployToken(address(bad));
        vm.prank(session);
        vm.expectRevert(LeashAccount.TokenTransferFailed.selector);
        a.executeTokenTransfer(address(bad), dest, 10e6);
    }

    function test_executeToken_noReturnToken_isAccepted() public {
        NoReturnToken nr = new NoReturnToken();
        LeashAccount a = _deployToken(address(nr));
        nr.mint(address(a), 100e6);
        vm.prank(session);
        a.executeTokenTransfer(address(nr), dest, 40e6);
        assertEq(nr.balanceOf(dest), 40e6);
        assertEq(a.spentInWindowToken(), 40e6);
    }

    function test_executeToken_reentrantToken_cannotDoubleSpend() public {
        ReentrantToken evil = new ReentrantToken();
        LeashAccount a = _deployToken(address(evil));
        evil.set(a, dest);
        evil.mint(address(a), 1_000e6);
        vm.prank(session);
        a.executeTokenTransfer(address(evil), dest, 50e6);
        // Guard held: the re-entry inside transfer() failed, so exactly ONE
        // spend was accounted and moved — no double-spend.
        assertFalse(evil.reentrySucceeded());
        assertEq(a.spentInWindowToken(), 50e6);
        assertEq(evil.balanceOf(dest), 50e6);
    }

    // ---------- token policy: tighten instant / loosen timelocked ----------

    function test_tightenTokenPolicy_instant() public {
        vm.prank(owner);
        acct.tightenTokenPolicy(LeashAccount.TokenPolicy({perTransferCapToken: 50e6, windowCapToken: 100e6}));
        (uint128 ptc, uint128 wc) = acct.tokenPolicy();
        assertEq(ptc, 50e6);
        assertEq(wc, 100e6);
    }

    function test_tightenTokenPolicy_rejectsLoosening() public {
        vm.prank(owner);
        vm.expectRevert(LeashAccount.NotTightening.selector);
        acct.tightenTokenPolicy(LeashAccount.TokenPolicy({perTransferCapToken: TOKEN_PER_TX + 1, windowCapToken: TOKEN_WINDOW}));
    }

    function test_proposeTokenPolicy_loosening_timelocked_thenApply() public {
        LeashAccount.TokenPolicy memory looser =
            LeashAccount.TokenPolicy({perTransferCapToken: 200e6, windowCapToken: 500e6});
        vm.prank(owner);
        acct.proposeTokenPolicy(looser);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(LeashAccount.TimelockNotElapsed.selector, uint64(block.timestamp) + DELAY));
        acct.applyTokenPolicy();
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applyTokenPolicy();
        (uint128 ptc, uint128 wc) = acct.tokenPolicy();
        assertEq(ptc, 200e6);
        assertEq(wc, 500e6);
    }

    function test_proposeTokenPolicy_rejectsTightening() public {
        vm.prank(owner);
        vm.expectRevert(LeashAccount.NotLoosening.selector);
        acct.proposeTokenPolicy(LeashAccount.TokenPolicy({perTransferCapToken: 10e6, windowCapToken: 20e6}));
    }

    function test_tightenTokenPolicy_clearsPendingTokenSlot_L05() public {
        vm.prank(owner);
        acct.proposeTokenPolicy(LeashAccount.TokenPolicy({perTransferCapToken: 200e6, windowCapToken: 500e6}));
        vm.warp(block.timestamp + DELAY);
        // tighten clears the matured loosening
        vm.prank(owner);
        acct.tightenTokenPolicy(LeashAccount.TokenPolicy({perTransferCapToken: 50e6, windowCapToken: 100e6}));
        assertEq(acct.pendingTokenPolicyEta(), 0);
        vm.prank(owner);
        vm.expectRevert(LeashAccount.NothingPending.selector);
        acct.applyTokenPolicy();
    }

    function test_revoke_clearsPendingTokenSlot_L05() public {
        vm.prank(owner);
        acct.proposeTokenPolicy(LeashAccount.TokenPolicy({perTransferCapToken: 200e6, windowCapToken: 500e6}));
        vm.prank(guardian);
        acct.revoke();
        assertEq(acct.pendingTokenPolicyEta(), 0);
    }

    function test_tokenPolicyOps_onNativeOnly_revertNoSettlementToken() public {
        address[] memory list = new address[](1);
        list[0] = dest;
        LeashAccount native = new LeashAccount(
            owner, guardian, session, _policy(), list, DELAY, address(0), LeashAccount.TokenPolicy(0, 0)
        );
        vm.prank(owner);
        vm.expectRevert(LeashAccount.NoSettlementToken.selector);
        native.tightenTokenPolicy(LeashAccount.TokenPolicy(1, 1));
    }

    function test_tokenPolicyOps_onlyOwner() public {
        vm.prank(rando);
        vm.expectRevert(LeashAccount.NotOwner.selector);
        acct.tightenTokenPolicy(LeashAccount.TokenPolicy(1, 1));
    }

    // ---------- fuzz ----------

    function testFuzz_executeToken_respectsPerTransferCap(uint256 amount) public {
        amount = bound(amount, 1, 500e6);
        vm.prank(session);
        if (amount > TOKEN_PER_TX) {
            vm.expectRevert(abi.encodeWithSelector(LeashAccount.OverPerTransferCapToken.selector, amount, TOKEN_PER_TX));
            acct.executeTokenTransfer(address(usd), dest, amount);
        } else {
            acct.executeTokenTransfer(address(usd), dest, amount);
            assertEq(acct.spentInWindowToken(), amount);
        }
    }

    function testFuzz_executeToken_windowCapNeverExceeded(uint256 a, uint256 b) public {
        a = bound(a, 1, TOKEN_PER_TX);
        b = bound(b, 1, TOKEN_PER_TX);
        vm.startPrank(session);
        acct.executeTokenTransfer(address(usd), dest, a);
        if (a + b > TOKEN_WINDOW) {
            vm.expectRevert(abi.encodeWithSelector(LeashAccount.OverWindowCapToken.selector, a + b, TOKEN_WINDOW));
            acct.executeTokenTransfer(address(usd), dest, b);
            assertEq(acct.spentInWindowToken(), a);
        } else {
            acct.executeTokenTransfer(address(usd), dest, b);
            assertEq(acct.spentInWindowToken(), a + b);
        }
        vm.stopPrank();
    }
}
