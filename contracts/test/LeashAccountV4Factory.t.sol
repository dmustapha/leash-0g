// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {LeashAccountV4Factory} from "../src/LeashAccountV4Factory.sol";
import {LeashAccountV4} from "../src/LeashAccountV4.sol";
import {MockERC20} from "../src/MockERC20.sol";

/// Stage D — the dedicated v4 factory. Regression guard for the EIP-170 overflow the
/// deployed drill caught: a combined v3+v4 factory exceeded 24,576 bytes and could not
/// deploy on 0G. This factory must stay UNDER the limit, and must produce working v4
/// accounts owned by the user (never the factory).
contract LeashAccountV4FactoryTest is Test {
    LeashAccountV4Factory internal factory;
    MockERC20 internal usd;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal session = makeAddr("session");

    function setUp() public {
        vm.warp(1_700_000_000);
        factory = new LeashAccountV4Factory();
        usd = new MockERC20("T", "T", 6);
    }

    function _policy() internal view returns (LeashAccountV4.Policy memory) {
        return LeashAccountV4.Policy({
            perTransferCap: 1 ether,
            windowCap: 3 ether,
            windowSeconds: 1 hours,
            expiresAt: uint64(block.timestamp + 30 days)
        });
    }

    function test_factory_underEip170SizeLimit() public view {
        // EIP-170: deployed contract bytecode must be <= 24,576 bytes.
        assertLe(address(factory).code.length, 24576, "V4 factory exceeds EIP-170 limit");
    }

    function test_createAccountV4_deploysWorkingAccount() public {
        address[] memory list = new address[](0);
        vm.expectEmit(false, true, false, false);
        emit LeashAccountV4Factory.AccountCreatedV4(address(0), owner, session, guardian);
        address acct =
            factory.createAccountV4(owner, guardian, session, _policy(), list, 15 minutes, address(usd), LeashAccountV4.TokenPolicy(100e6, 250e6));

        LeashAccountV4 a = LeashAccountV4(payable(acct));
        assertEq(a.owner(), owner);
        assertEq(a.sessionKey(), session);
        assertEq(a.guardian(), guardian);
        assertEq(a.settlementToken(), address(usd));
        // the factory keeps NO authority
        assertTrue(a.owner() != address(factory));
    }

    function test_versionConstant() public view {
        assertEq(factory.ACCOUNT_VERSION_V4(), 4);
    }
}
