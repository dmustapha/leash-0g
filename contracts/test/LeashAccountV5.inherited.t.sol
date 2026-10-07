// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {LeashAccountV5} from "../src/LeashAccountV5.sol";
import {DecodeLib} from "../src/DecodeLib.sol";
import {SigningLib} from "../src/SigningLib.sol";
import {MockERC20} from "../src/MockERC20.sol";

/// A target that re-enters executeCall during its own call (H-06).
contract ReentrantTargetV5 {
    LeashAccountV5 public acct;
    bytes public payload;
    bool public reentrySucceeded;
    bool private attacking;

    function set(LeashAccountV5 a, bytes calldata p) external {
        acct = a;
        payload = p;
    }

    fallback() external payable {
        if (!attacking) {
            attacking = true;
            try acct.executeCall(address(this), 0, payload) {
                reentrySucceeded = true;
            } catch {}
            attacking = false;
        }
    }
}

contract FakeSuccessTokenV5 {
    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }
}

/// Stage F′ FP-1 — FULL contract re-audit (C-02 reopens). Proves the V5 governed-calldata
/// wall INHERITED from V4 still holds the drain-vector catalog unchanged — the signing
/// layer + FP-CARRY must not have weakened any Stage-D/E guarantee.
contract LeashAccountV5InheritedTest is Test {
    LeashAccountV5 internal acct;
    MockERC20 internal usd;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal session = makeAddr("session");
    address internal attacker = makeAddr("attacker");
    address internal spender = makeAddr("spender");

    uint32 constant WINDOW_SECONDS = 1 hours;
    uint64 constant DELAY = 15 minutes;
    bytes4 constant SEL_APPROVE = 0x095ea7b3;
    bytes4 constant SEL_TRANSFER = 0xa9059cbb;
    bytes4 constant SEL_TRANSFER_FROM = 0x23b872dd;
    bytes4 constant SEL_SET_APPROVAL_FOR_ALL = 0xa22cb465;

    function _policy() internal view returns (LeashAccountV5.Policy memory) {
        return LeashAccountV5.Policy(1 ether, 3 ether, WINDOW_SECONDS, uint64(block.timestamp + 30 days));
    }

    function setUp() public {
        vm.warp(1_700_000_000);
        usd = new MockERC20("Test USD", "TUSD", 6);
        address[] memory list = new address[](1);
        list[0] = makeAddr("beneficiary");
        acct = new LeashAccountV5(owner, guardian, session, _policy(), list, DELAY, address(usd), LeashAccountV5.TokenPolicy(100e6, 250e6), address(new SigningLib()), address(new DecodeLib()));
        usd.mint(address(acct), 1_000e6);
        vm.deal(address(acct), 100 ether);
    }

    function _sp(address a) internal pure returns (address[] memory s) {
        s = new address[](1);
        s[0] = a;
    }

    function _grant(address target, bytes4 sel, uint8 mode, address[] memory sp, uint128 pcc, uint128 wcc) internal {
        vm.prank(owner);
        acct.proposeCallRule(target, sel, mode, sp, pcc, wcc, bytes32(0));
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applyCallRule();
    }

    function _budget(address token, uint128 cap) internal {
        vm.prank(owner);
        acct.proposeSpendBudget(token, cap);
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applySpendBudget();
    }

    function test_C01_infiniteApprove_reverts() public {
        _budget(address(usd), 500e6);
        _grant(address(usd), SEL_APPROVE, 0, _sp(spender), 200e6, 400e6);
        vm.prank(session);
        vm.expectRevert(LeashAccountV5.InfiniteApprovalForbidden.selector);
        acct.executeCall(address(usd), 0, abi.encodeWithSelector(SEL_APPROVE, spender, type(uint256).max));
    }

    function test_C04_transferRedirect_reverts() public {
        _budget(address(usd), 500e6);
        _grant(address(usd), SEL_TRANSFER, 0, new address[](0), 200e6, 400e6);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV5.RecipientNotSelf.selector, attacker));
        acct.executeCall(address(usd), 0, abi.encodeWithSelector(SEL_TRANSFER, attacker, 10e6));
    }

    function test_H02_cumulativeAmountCap() public {
        _budget(address(usd), 120e6);
        _grant(address(usd), SEL_TRANSFER, 1, new address[](0), 100e6, 1_000e6);
        vm.startPrank(session);
        acct.executeCall(address(usd), 0, abi.encodeWithSelector(SEL_TRANSFER, makeAddr("beneficiary"), 100e6));
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV5.OverCumulativeSpend.selector, 130e6, uint128(120e6)));
        acct.executeCall(address(usd), 0, abi.encodeWithSelector(SEL_TRANSFER, makeAddr("beneficiary"), 30e6));
        vm.stopPrank();
    }

    function test_H03_transferFromVictim_reverts() public {
        _budget(address(usd), 500e6);
        _grant(address(usd), SEL_TRANSFER_FROM, 1, new address[](0), 200e6, 400e6);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV5.RecipientNotSelf.selector, attacker));
        acct.executeCall(address(usd), 0, abi.encodeWithSelector(SEL_TRANSFER_FROM, attacker, makeAddr("beneficiary"), 10e6));
    }

    function test_H04_dirtyHighBits_reverts() public {
        _budget(address(usd), 500e6);
        _grant(address(usd), SEL_TRANSFER, 1, new address[](0), 200e6, 400e6);
        bytes memory data = abi.encodePacked(SEL_TRANSFER, bytes32(uint256(0xdead) << 160 | uint256(uint160(makeAddr("beneficiary")))), uint256(10e6));
        vm.prank(session);
        vm.expectRevert(LeashAccountV5.DecodeMismatch.selector);
        acct.executeCall(address(usd), 0, data);
    }

    function test_H05_fakeSuccessToken_reverts() public {
        FakeSuccessTokenV5 fake = new FakeSuccessTokenV5();
        _budget(address(fake), 500e6);
        _grant(address(fake), SEL_TRANSFER, 1, new address[](0), 200e6, 400e6);
        vm.prank(session);
        vm.expectRevert(LeashAccountV5.TokenTransferFailed.selector);
        acct.executeCall(address(fake), 0, abi.encodeWithSelector(SEL_TRANSFER, makeAddr("beneficiary"), 10e6));
    }

    function test_H06_reentrancy_blocked() public {
        ReentrantTargetV5 evil = new ReentrantTargetV5();
        _budget(address(0), 0);
        _grant(address(evil), bytes4(0x12345678), 0, new address[](0), 0, 1_000e6);
        evil.set(acct, abi.encodeWithSelector(bytes4(0x12345678)));
        vm.prank(session);
        acct.executeCall(address(evil), 0, abi.encodeWithSelector(bytes4(0x12345678)));
        assertFalse(evil.reentrySucceeded(), "reentrancy must be blocked");
    }

    function test_M01_setApprovalForAllTrue_reverts() public {
        _grant(address(usd), SEL_SET_APPROVAL_FOR_ALL, 0, _sp(spender), 0, 0);
        vm.prank(session);
        vm.expectRevert(LeashAccountV5.BlanketApprovalForbidden.selector);
        acct.executeCall(address(usd), 0, abi.encodeWithSelector(SEL_SET_APPROVAL_FOR_ALL, spender, true));
    }

    function test_C03_noDelegatecallOpcode() public view {
        bytes memory code = address(acct).code;
        uint256 n = code.length;
        uint256 metaLen = (uint256(uint8(code[n - 2])) << 8) | uint256(uint8(code[n - 1]));
        uint256 end = n >= metaLen + 2 ? n - metaLen - 2 : n;
        uint256 i = 0;
        while (i < end) {
            uint8 op = uint8(code[i]);
            require(op != 0xf4 && op != 0xf2, "delegatecall/callcode present");
            if (op >= 0x60 && op <= 0x7f) i += (op - 0x5f);
            i += 1;
        }
    }

    function test_redteam_agentCannotGrantOwnRule() public {
        vm.prank(session);
        vm.expectRevert(LeashAccountV5.NotOwner.selector);
        acct.proposeCallRule(address(usd), SEL_APPROVE, 0, _sp(attacker), 1e30, 1e30, bytes32(0));
    }
}
