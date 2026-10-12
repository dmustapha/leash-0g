// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {LeashAccount} from "../src/LeashAccount.sol";

/// Allowlisted destination that attempts to re-enter execute on receipt of ETH.
/// nonReentrant + onlySessionKey MUST block the re-entry; the window-cap invariant
/// must hold even when a spend lands in a reentrant payment path (G3: reentrancy-under-load).
contract ReentrantDest {
    LeashAccount public target;

    function wire(LeashAccount t) external {
        target = t;
    }

    receive() external payable {
        // Re-enter mid-call; MUST revert — nonReentrant triggers before any caller
        // check, so the re-entry is blocked regardless of msg.sender. Swallowed.
        try target.execute(address(this), 1, "") {} catch {}
    }
}

/// Handler that the fuzzer drives: random executes, warps, revokes, reentrant executes.
contract LeashHandler is Test {
    LeashAccount public acct;
    address public owner;
    address public guardian;
    address public session;
    address public dest;
    ReentrantDest public reDest;

    bool public everRevoked;
    uint256 public executesAfterRevoke;

    constructor(LeashAccount a, address o, address g, address s, address d, ReentrantDest r) {
        acct = a;
        owner = o;
        guardian = g;
        session = s;
        dest = d;
        reDest = r;
    }

    function doExecute(uint96 amount) external {
        amount = uint96(bound(amount, 1, 2 ether));
        vm.prank(session);
        try acct.execute(dest, amount, "") {
            if (acct.revoked()) executesAfterRevoke++;
        } catch {}
    }

    /// Spend into the reentrant destination: its receive() re-enters execute.
    /// The outer spend may succeed, but the inner re-entry MUST be blocked by
    /// nonReentrant, so spentInWindow never exceeds windowCap under this path.
    function doExecuteReentrant(uint96 amount) external {
        amount = uint96(bound(amount, 1, 2 ether));
        vm.prank(session);
        try acct.execute(address(reDest), amount, "") {
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

    ReentrantDest internal reDest;

    function setUp() public {
        vm.warp(1_700_000_000);
        reDest = new ReentrantDest();
        address[] memory list = new address[](2);
        list[0] = dest;
        list[1] = address(reDest); // allowlist the reentrant destination
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
        reDest.wire(acct);
        vm.deal(address(acct), 10_000 ether);
        handler = new LeashHandler(acct, owner, guardian, session, dest, reDest);
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
