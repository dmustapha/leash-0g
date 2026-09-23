// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {LeashAccount} from "../src/LeashAccount.sol";

/// Handler that the fuzzer drives: random executes, warps, revokes.
contract LeashHandler is Test {
    LeashAccount public acct;
    address public owner;
    address public guardian;
    address public session;
    address public dest;

    bool public everRevoked;
    uint256 public executesAfterRevoke;

    constructor(LeashAccount a, address o, address g, address s, address d) {
        acct = a;
        owner = o;
        guardian = g;
        session = s;
        dest = d;
    }

    function doExecute(uint96 amount) external {
        amount = uint96(bound(amount, 1, 2 ether));
        vm.prank(session);
        try acct.execute(dest, amount, "") {
            if (acct.revoked()) executesAfterRevoke++;
        } catch {}
    }

    function doWarp(uint32 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 3 hours));
    }

    function doRevoke(uint8 who) external {
        address caller = who % 2 == 0 ? owner : guardian;
        vm.prank(caller);
        try acct.revoke() {
            everRevoked = true;
        } catch {}
    }
}

contract LeashAccountInvariantTest is Test {
    LeashAccount internal acct;
    LeashHandler internal handler;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal session = makeAddr("session");
    address internal dest = makeAddr("dest");

    uint128 constant WINDOW_CAP = 3 ether;

    function setUp() public {
        vm.warp(1_700_000_000);
        address[] memory list = new address[](1);
        list[0] = dest;
        acct = new LeashAccount(
            owner,
            guardian,
            session,
            LeashAccount.Policy({
                perTransferCap: 1 ether,
                windowCap: WINDOW_CAP,
                windowSeconds: 1 hours,
                expiresAt: uint64(block.timestamp + 3650 days)
            }),
            list,
            15 minutes,
            address(0),
            LeashAccount.TokenPolicy({perTransferCapToken: 0, windowCapToken: 0})
        );
        vm.deal(address(acct), 10_000 ether);
        handler = new LeashHandler(acct, owner, guardian, session, dest);
        targetContract(address(handler));
    }

    /// spentInWindow can never exceed windowCap
    function invariant_spentInWindowNeverExceedsWindowCap() public view {
        assertLe(acct.spentInWindow(), WINDOW_CAP);
    }

    /// once revoked (and never re-armed — handler never rearms), execute NEVER succeeds
    function invariant_revokedMeansNoExecuteEver() public view {
        assertEq(handler.executesAfterRevoke(), 0);
        if (handler.everRevoked()) {
            assertTrue(acct.revoked()); // nothing but the owner can re-arm
        }
    }
}
