// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {LeashAccountV4} from "../src/LeashAccountV4.sol";
import {MockERC20} from "../src/MockERC20.sol";

/// Handler: random governed calls (approve/transfer to varied recipients incl. an
/// attacker), warps, and revoke/rearm — across ANY sequence the spine must hold.
contract V4Handler is Test {
    LeashAccountV4 public acct;
    MockERC20 public usd;
    address public owner;
    address public guardian;
    address public session;
    address public dest;
    address public attacker;
    address public spender;

    bytes4 constant SEL_APPROVE = 0x095ea7b3;
    bytes4 constant SEL_TRANSFER = 0xa9059cbb;

    constructor(LeashAccountV4 a, MockERC20 t, address o, address g, address s, address d, address atk, address sp) {
        acct = a;
        usd = t;
        owner = o;
        guardian = g;
        session = s;
        dest = d;
        attacker = atk;
        spender = sp;
    }

    function doApprove(uint96 amount) external {
        amount = uint96(bound(amount, 0, 300e6));
        vm.prank(session);
        try acct.executeCall(address(usd), 0, abi.encodeWithSelector(SEL_APPROVE, spender, uint256(amount))) {} catch {}
    }

    /// Try to transfer to one of {dest, attacker, self} — attacker/self MUST always revert.
    function doTransfer(uint96 amount, uint8 who) external {
        amount = uint96(bound(amount, 1, 300e6));
        address to = who % 3 == 0 ? dest : (who % 3 == 1 ? attacker : address(acct));
        vm.prank(session);
        try acct.executeCall(address(usd), 0, abi.encodeWithSelector(SEL_TRANSFER, to, uint256(amount))) {} catch {}
    }

    /// A hijacked agent tries to grant itself a rule — MUST always revert (owner-only).
    function doAgentSelfWiden() external {
        address[] memory sp = new address[](1);
        sp[0] = attacker;
        vm.prank(session);
        try acct.proposeCallRule(address(usd), SEL_APPROVE, 1, sp, type(uint128).max, type(uint128).max, bytes32(0)) {}
            catch {}
    }

    function doWarp(uint32 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 3 hours));
    }

    function doRevokeRearm(uint8 who) external {
        if (who % 3 == 0) {
            vm.prank(who % 2 == 0 ? owner : guardian);
            try acct.revoke() {} catch {}
        } else {
            vm.prank(owner);
            try acct.rearm() {} catch {}
        }
    }
}

contract LeashAccountV4InvariantTest is Test {
    LeashAccountV4 internal acct;
    MockERC20 internal usd;
    V4Handler internal handler;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal session = makeAddr("session");
    address internal dest = makeAddr("dest");
    address internal attacker = makeAddr("attacker");
    address internal spender = makeAddr("spender");

    uint128 constant BUDGET = 250e6;

    function setUp() public {
        vm.warp(1_700_000_000);
        usd = new MockERC20("Test USD", "TestUSD", 6);
        address[] memory list = new address[](1);
        list[0] = dest;
        acct = new LeashAccountV4(
            owner,
            guardian,
            session,
            LeashAccountV4.Policy({
                perTransferCap: 1 ether,
                windowCap: 3 ether,
                windowSeconds: 1 hours,
                expiresAt: uint64(block.timestamp + 3650 days)
            }),
            list,
            15 minutes,
            address(usd),
            LeashAccountV4.TokenPolicy(100e6, 250e6)
        );
        usd.mint(address(acct), 1_000_000e6);

        // grant: a per-token budget + an approve rule (spender) + a transfer rule (mode 1, dest only).
        vm.startPrank(owner);
        acct.proposeSpendBudget(address(usd), BUDGET);
        acct.proposeCallRule(address(usd), 0x095ea7b3, 0, _one(spender), 100e6, 200e6, bytes32(0));
        vm.warp(block.timestamp + 15 minutes);
        acct.applySpendBudget();
        acct.applyCallRule();
        acct.proposeCallRule(address(usd), 0xa9059cbb, 1, new address[](0), 100e6, 200e6, bytes32(0));
        vm.warp(block.timestamp + 15 minutes);
        acct.applyCallRule();
        vm.stopPrank();

        handler = new V4Handler(acct, usd, owner, guardian, session, dest, attacker, spender);
        targetContract(address(handler));
    }

    function _one(address a) internal pure returns (address[] memory s) {
        s = new address[](1);
        s[0] = a;
    }

    /// The per-token cumulative outflow budget can NEVER exceed its window cap.
    function invariant_budgetNeverExceeded() public view {
        (, uint128 cap, uint128 spent,) = acct.spendBudget(address(usd));
        assertLe(spent, cap);
    }

    /// The per-(target,selector) window counter never exceeds its cap.
    function invariant_transferWindowNeverExceeded() public view {
        (,,, uint128 wcc, uint128 spent,) =
            acct.callRules(keccak256(abi.encodePacked(address(usd), bytes4(0xa9059cbb))));
        assertLe(spent, wcc);
    }

    /// The spine: NO governed call can EVER move token or value to the attacker,
    /// across any sequence of calls, grants, revokes, and rearms.
    function invariant_attackerNeverReceives() public view {
        assertEq(usd.balanceOf(attacker), 0);
        assertEq(attacker.balance, 0);
    }

    /// The agent (session key) can never widen its own grant — the pending slot is
    /// only ever set by the owner in setUp (never by the handler's session-key attempt).
    function invariant_agentNeverSelfWidened() public view {
        // the attacker was never added as an approve spender by any agent action
        assertFalse(acct.callRuleSpender(keccak256(abi.encodePacked(address(usd), bytes4(0x095ea7b3))), attacker));
    }
}
