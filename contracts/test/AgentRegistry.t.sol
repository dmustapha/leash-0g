// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";

contract AgentRegistryTest is Test {
    AgentRegistry internal reg;
    address internal owner = makeAddr("owner");
    address internal other = makeAddr("other");
    address internal account = makeAddr("account");
    address internal session = makeAddr("session");
    bytes internal pubkey = hex"04aabbcc";

    function setUp() public {
        reg = new AgentRegistry();
    }

    function test_register_storesAgentAndAssignsIds() public {
        vm.prank(owner);
        uint256 id0 = reg.register(account, session, pubkey, "treasury-agent");
        vm.prank(other);
        uint256 id1 = reg.register(account, session, pubkey, "second");
        assertEq(id1, id0 + 1);

        AgentRegistry.Agent memory a = reg.getAgent(id0);
        assertEq(a.owner, owner);
        assertEq(a.account, account);
        assertEq(a.sessionKey, session);
        assertEq(a.auditPubKey, pubkey);
        assertEq(a.name, "treasury-agent");
        assertEq(uint8(a.status), uint8(AgentRegistry.Status.Active));
    }

    function test_register_emitsEvent() public {
        vm.expectEmit(true, true, false, true);
        emit AgentRegistry.AgentRegistered(0, owner, account, session);
        vm.prank(owner);
        reg.register(account, session, pubkey, "x");
    }

    function test_register_rejectsZeroAccountOrSessionKey() public {
        vm.prank(owner);
        vm.expectRevert(AgentRegistry.ZeroAddress.selector);
        reg.register(address(0), session, pubkey, "x");
        vm.prank(owner);
        vm.expectRevert(AgentRegistry.ZeroAddress.selector);
        reg.register(account, address(0), pubkey, "x");
    }

    function test_setStatus_ownerOnly() public {
        vm.prank(owner);
        uint256 id = reg.register(account, session, pubkey, "x");

        vm.prank(other);
        vm.expectRevert(AgentRegistry.NotAgentOwner.selector);
        reg.setStatus(id, AgentRegistry.Status.Revoked);

        vm.prank(owner);
        reg.setStatus(id, AgentRegistry.Status.Revoked);
        assertEq(uint8(reg.getAgent(id).status), uint8(AgentRegistry.Status.Revoked));
    }

    function test_setMetadata_ownerOnly_updates() public {
        vm.prank(owner);
        uint256 id = reg.register(account, session, pubkey, "x");

        vm.prank(other);
        vm.expectRevert(AgentRegistry.NotAgentOwner.selector);
        reg.setMetadata(id, other, hex"05", "hax");

        address newSession = makeAddr("newSession");
        vm.prank(owner);
        reg.setMetadata(id, newSession, hex"04dd", "renamed");
        AgentRegistry.Agent memory a = reg.getAgent(id);
        assertEq(a.sessionKey, newSession);
        assertEq(a.auditPubKey, hex"04dd");
        assertEq(a.name, "renamed");
    }

    function test_getAgent_unknownIdReverts() public {
        vm.expectRevert(AgentRegistry.AgentNotFound.selector);
        reg.getAgent(42);
    }
}
