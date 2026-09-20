// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {LeashAccount} from "../src/LeashAccount.sol";
import {LeashAccountFactory} from "../src/LeashAccountFactory.sol";

contract LeashAccountFactoryTest is Test {
    LeashAccountFactory internal factory;
    address internal ops = makeAddr("ops"); // LEASH deployer/guardian key
    address internal user = makeAddr("user"); // the owner
    address internal session = makeAddr("session");
    address internal dest = makeAddr("dest");

    function setUp() public {
        vm.warp(1_700_000_000);
        factory = new LeashAccountFactory();
    }

    function _policy() internal view returns (LeashAccount.Policy memory) {
        return LeashAccount.Policy({
            perTransferCap: 1 ether,
            windowCap: 3 ether,
            windowSeconds: 1 hours,
            expiresAt: uint64(block.timestamp + 30 days)
        });
    }

    function test_createAccount_ownerIsUser_deployerGetsNothing() public {
        address[] memory list = new address[](1);
        list[0] = dest;

        vm.prank(ops);
        address accountAddr = factory.createAccount(user, ops, session, _policy(), list, 15 minutes);

        LeashAccount acct = LeashAccount(payable(accountAddr));
        assertEq(acct.owner(), user); // the USER owns it, not the deployer
        assertEq(acct.guardian(), ops); // ops = guardian (revoke-only)
        assertEq(acct.sessionKey(), session);
        assertTrue(acct.allowlist(dest));

        // the ops key has no owner powers on the account
        vm.prank(ops);
        vm.expectRevert(LeashAccount.NotOwner.selector);
        acct.setSessionKey(ops);
        vm.prank(ops);
        vm.expectRevert(LeashAccount.NotOwner.selector);
        acct.proposeWithdraw(ops, 1 ether);

        // but CAN revoke (guardian role)
        vm.prank(ops);
        acct.revoke();
        assertTrue(acct.revoked());
    }

    function test_createAccount_emitsEvent() public {
        address[] memory list = new address[](0);
        vm.expectEmit(false, true, false, false);
        emit LeashAccountFactory.AccountCreated(address(0), user, session, ops);
        vm.prank(ops);
        factory.createAccount(user, ops, session, _policy(), list, 15 minutes);
    }
}
