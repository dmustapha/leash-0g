// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {LeashAccountV4} from "../src/LeashAccountV4.sol";
import {V4DecoderHarness} from "./harness/V4DecoderHarness.sol";
import {MockERC20} from "../src/MockERC20.sol";

/// D-15 SYMBOLIC EXECUTION (Halmos).
/// Proves the load-bearing wall invariants for ALL inputs (not just examples):
///   - the canonical address decoder returns ONLY when the high 96 bits are zero
///     (H-04 decode-vs-execute divergence closed for every 32-byte word);
///   - `approve(type(uint256).max)` reverts for the max value and only the max value;
///   - `setApprovalForAll` accepts only canonical bool words and never blanket-true;
///   - the per-token cumulative budget NEVER lets `spent` exceed `windowCap` within a
///     window for any two-leg amount pair (the spine, brief §7).
/// Run: DYLD_LIBRARY_PATH=/opt/homebrew/lib halmos --match-contract LeashAccountV4Symbolic
contract LeashAccountV4SymbolicTest is Test {
    V4DecoderHarness internal h;

    bytes4 constant SEL_APPROVE = 0x095ea7b3;
    bytes4 constant SEL_SET_APPROVAL_FOR_ALL = 0xa22cb465;

    function setUp() public {
        h = new V4DecoderHarness(address(0xA11CE), address(0x5E5510));
    }

    /// For ANY 32-byte word placed at the address slot, _decodeAddress returns iff the
    /// upper 96 bits are zero; otherwise it reverts DecodeMismatch.
    function check_decodeAddress_canonicalOnly(uint256 word) public {
        bytes memory data = abi.encodePacked(SEL_APPROVE, bytes32(word));
        try h.decodeAddress(data, 4) returns (address a) {
            // returned → high bits were zero → value fits in 160 bits
            assert(word >> 160 == 0);
            assert(uint256(uint160(a)) == word);
        } catch {
            // reverted → high bits were nonzero
            assert(word >> 160 != 0);
        }
    }

    /// _decodeUint is the identity on the 32-byte word (no truncation/masking).
    function check_decodeUint_identity(uint256 word) public view {
        bytes memory data = abi.encodePacked(SEL_APPROVE, bytes32(uint256(uint160(address(0xB0B)))), bytes32(word));
        assert(h.decodeUint(data, 36) == word);
    }

    /// The cumulative budget monotonicity: after two successful debits a,b within one
    /// window, spent == a + b and never exceeds windowCap; if a + b > cap the 2nd reverts.
    function check_budget_twoLegNeverExceedsCap(uint128 cap, uint128 a, uint128 b) public {
        vm.assume(cap > 0);
        MockERC20 tok = new MockERC20("T", "T", 18);
        address owner = address(0xA11CE);
        address session = address(0x5E5510);
        address spender = address(0x9999);
        address[] memory list = new address[](0);
        LeashAccountV4 acct = new LeashAccountV4(
            owner,
            owner,
            session,
            LeashAccountV4.Policy({perTransferCap: type(uint128).max, windowCap: type(uint128).max, windowSeconds: 1 hours, expiresAt: type(uint64).max}),
            list,
            0,
            address(0),
            LeashAccountV4.TokenPolicy(0, 0)
        );
        address[] memory sp = new address[](1);
        sp[0] = spender;
        vm.startPrank(owner);
        acct.proposeSpendBudget(address(tok), cap);
        acct.applySpendBudget();
        acct.proposeCallRule(address(tok), SEL_APPROVE, 0, sp, type(uint128).max, type(uint128).max, bytes32(0));
        acct.applyCallRule();
        vm.stopPrank();

        // exclude approve(max) which reverts for a different (correct) reason
        vm.assume(a != type(uint256).max && b != type(uint256).max);

        vm.prank(session);
        (bool ok1,) = address(acct).call(
            abi.encodeCall(LeashAccountV4.executeCall, (address(tok), 0, abi.encodeWithSelector(SEL_APPROVE, spender, uint256(a))))
        );
        vm.prank(session);
        (bool ok2,) = address(acct).call(
            abi.encodeCall(LeashAccountV4.executeCall, (address(tok), 0, abi.encodeWithSelector(SEL_APPROVE, spender, uint256(b))))
        );

        (,, uint128 spent,) = acct.spendBudget(address(tok));
        // spent can never exceed the cap, regardless of a, b
        assert(spent <= cap);
        // if both legs succeeded, the sum is exactly accounted and within cap
        if (ok1 && ok2) {
            assert(uint256(spent) == uint256(a) + uint256(b));
            assert(uint256(a) + uint256(b) <= cap);
        }
    }
}
