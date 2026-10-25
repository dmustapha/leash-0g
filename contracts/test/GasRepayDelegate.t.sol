// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {GasRepayDelegate} from "../src/GasRepayDelegate.sol";
import {MockERC20} from "../src/MockERC20.sol";

/// AQ-FND M-3 — the 7702 bootstrap delegate. Foundry's `vm.etch`-style 7702 attach via
/// `vm.signAndAttachDelegation` runs the delegate AS the EOA, exactly as a type-4 tx does
/// (proven live on 0G in probe P-GAS-1).
contract GasRepayDelegateTest is Test {
    GasRepayDelegate internal impl;
    MockERC20 internal usd;

    uint256 internal sessionPk = 0xA11CE;
    address internal sessionEOA;
    address internal relayer = makeAddr("relayer");
    address internal attacker = makeAddr("attacker");

    function setUp() public {
        vm.warp(1_700_000_000);
        impl = new GasRepayDelegate();
        usd = new MockERC20("Test USD", "TUSD", 18);
        sessionEOA = vm.addr(sessionPk);
        usd.mint(sessionEOA, 100 ether);
        // the EOA delegates to the audited immutable delegate (chain-pinned type-4)
        vm.signAndAttachDelegation(address(impl), sessionPk);
    }

    function _voucher(GasRepayDelegate.Call[] memory calls, uint256 nonce, uint256 deadline, address rel)
        internal
        view
        returns (bytes memory sig)
    {
        bytes32 digest =
            keccak256(abi.encode(block.chainid, sessionEOA, nonce, deadline, rel, keccak256(abi.encode(calls))));
        bytes32 signed = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sessionPk, signed);
        sig = abi.encodePacked(r, s, v);
    }

    function _repayCall(uint256 amount) internal view returns (GasRepayDelegate.Call[] memory calls) {
        calls = new GasRepayDelegate.Call[](1);
        calls[0] = GasRepayDelegate.Call({
            target: address(usd),
            value: 0,
            data: abi.encodeWithSelector(usd.transfer.selector, relayer, amount)
        });
    }

    function test_bootstrap_executes_and_repays_relayer() public {
        GasRepayDelegate.Call[] memory calls = _repayCall(5 ether);
        bytes memory sig = _voucher(calls, 1, block.timestamp + 300, relayer);
        vm.prank(relayer);
        GasRepayDelegate(payable(sessionEOA)).bootstrap(calls, 1, block.timestamp + 300, relayer, sig);
        assertEq(usd.balanceOf(relayer), 5 ether); // the token paid; relayer made whole in-tx
    }

    function test_replay_refused() public {
        GasRepayDelegate.Call[] memory calls = _repayCall(5 ether);
        bytes memory sig = _voucher(calls, 1, block.timestamp + 300, relayer);
        vm.prank(relayer);
        GasRepayDelegate(payable(sessionEOA)).bootstrap(calls, 1, block.timestamp + 300, relayer, sig);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(GasRepayDelegate.NonceUsed.selector, 1));
        GasRepayDelegate(payable(sessionEOA)).bootstrap(calls, 1, block.timestamp + 300, relayer, sig);
    }

    function test_wrongRelayer_refused() public {
        GasRepayDelegate.Call[] memory calls = _repayCall(5 ether);
        bytes memory sig = _voucher(calls, 1, block.timestamp + 300, relayer);
        vm.prank(attacker);
        vm.expectRevert(GasRepayDelegate.NotRelayer.selector);
        GasRepayDelegate(payable(sessionEOA)).bootstrap(calls, 1, block.timestamp + 300, relayer, sig);
    }

    function test_forgedVoucher_refused() public {
        GasRepayDelegate.Call[] memory calls = _repayCall(100 ether); // attacker-sized drain
        bytes32 digest =
            keccak256(abi.encode(block.chainid, sessionEOA, 1, block.timestamp + 300, relayer, keccak256(abi.encode(calls))));
        bytes32 signed = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, signed); // NOT the EOA's key
        vm.prank(relayer);
        vm.expectRevert(GasRepayDelegate.BadVoucherSignature.selector);
        GasRepayDelegate(payable(sessionEOA)).bootstrap(calls, 1, block.timestamp + 300, relayer, abi.encodePacked(r, s, v));
    }

    function test_tamperedCalls_refused() public {
        GasRepayDelegate.Call[] memory calls = _repayCall(5 ether);
        bytes memory sig = _voucher(calls, 1, block.timestamp + 300, relayer);
        GasRepayDelegate.Call[] memory tampered = _repayCall(50 ether); // relayer inflates repayment
        vm.prank(relayer);
        vm.expectRevert(GasRepayDelegate.BadVoucherSignature.selector);
        GasRepayDelegate(payable(sessionEOA)).bootstrap(tampered, 1, block.timestamp + 300, relayer, sig);
    }

    function test_expiredVoucher_refused() public {
        GasRepayDelegate.Call[] memory calls = _repayCall(5 ether);
        uint256 deadline = block.timestamp + 300;
        bytes memory sig = _voucher(calls, 1, deadline, relayer);
        vm.warp(deadline + 1);
        vm.prank(relayer);
        vm.expectRevert(GasRepayDelegate.Expired.selector);
        GasRepayDelegate(payable(sessionEOA)).bootstrap(calls, 1, deadline, relayer, sig);
    }

    function test_crossChainVoucher_refused() public {
        GasRepayDelegate.Call[] memory calls = _repayCall(5 ether);
        // voucher signed for a DIFFERENT chain id — chain pinning in the digest
        bytes32 digest =
            keccak256(abi.encode(block.chainid + 1, sessionEOA, 1, block.timestamp + 300, relayer, keccak256(abi.encode(calls))));
        bytes32 signed = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sessionPk, signed);
        vm.prank(relayer);
        vm.expectRevert(GasRepayDelegate.BadVoucherSignature.selector);
        GasRepayDelegate(payable(sessionEOA)).bootstrap(calls, 1, block.timestamp + 300, relayer, abi.encodePacked(r, s, v));
    }
}
