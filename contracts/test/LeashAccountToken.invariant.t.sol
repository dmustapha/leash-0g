// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {LeashAccount} from "../src/LeashAccount.sol";
import {MockERC20} from "../src/MockERC20.sol";

/// Handler: random token executes, warps, revokes, token-cap tightens.
contract TokenHandler is Test {
    LeashAccount public acct;
    MockERC20 public usd;
    address public owner;
    address public guardian;
    address public session;
    address public dest;

    constructor(LeashAccount a, MockERC20 t, address o, address g, address s, address d) {
        acct = a;
        usd = t;
        owner = o;
        guardian = g;
        session = s;
        dest = d;
    }

    function doTokenExecute(uint96 amount) external {
        amount = uint96(bound(amount, 1, 300e6));
        vm.prank(session);
        try acct.executeTokenTransfer(address(usd), dest, amount) {} catch {}
    }

    function doWarp(uint32 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 3 hours));
    }

    // NOTE: no tighten action here (matches the native invariant handler). An
    // owner tightening the window cap BELOW the already-accounted spend is valid
    // fail-safe behavior (every future spend then reverts until the window
    // rolls over), so `spent <= currentCap` is deliberately NOT asserted across
    // a mid-window tighten — that path is pinned by the unit tests instead.

    function doRevoke(uint8 who) external {
        address caller = who % 2 == 0 ? owner : guardian;
        vm.prank(caller);
        try acct.revoke() {} catch {}
    }
}

contract LeashAccountTokenInvariantTest is Test {
    LeashAccount internal acct;
    MockERC20 internal usd;
    TokenHandler internal handler;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal session = makeAddr("session");
    address internal dest = makeAddr("dest");

    function setUp() public {
        vm.warp(1_700_000_000);
        usd = new MockERC20("Test USD", "TestUSD", 6);
        address[] memory list = new address[](1);
        list[0] = dest;
        acct = new LeashAccount(
            owner,
            guardian,
            session,
            LeashAccount.Policy({
                perTransferCap: 1 ether,
                windowCap: 3 ether,
                windowSeconds: 1 hours,
                expiresAt: uint64(block.timestamp + 3650 days)
            }),
            list,
            15 minutes,
            address(usd),
            LeashAccount.TokenPolicy({perTransferCapToken: 100e6, windowCapToken: 250e6})
        );
        usd.mint(address(acct), 1_000_000e6);
        handler = new TokenHandler(acct, usd, owner, guardian, session, dest);
        targetContract(address(handler));
    }

    /// spentInWindowToken can never exceed windowCapToken (spec §8).
    function invariant_tokenSpentNeverExceedsTokenWindowCap() public view {
        (, uint128 windowCapToken) = acct.tokenPolicy();
        assertLe(acct.spentInWindowToken(), windowCapToken);
    }
}
