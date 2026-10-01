// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LeashAccountV4} from "../src/LeashAccountV4.sol";
import {MockERC20} from "../src/MockERC20.sol";

/// SE-8 red-team: cross-chain one-shot replay (attack class 2).
/// Models the SAME account (same owner/session/guardian/tuple → same CREATE2
/// address) deployed on two chains as TWO independent LeashAccountV4 instances
/// (EVM storage on chain A and chain B is physically disjoint). SE-9 carry #4
/// hardens this further: the callHash now binds `block.chainid`, so the SAME
/// bytes yield a DIFFERENT callHash per chain — cross-chain replay is refused
/// STRUCTURALLY (hash mismatch), not merely by disjoint storage.
contract RedTeamCrossChainOneShot is Test {
    LeashAccountV4 internal chainA;
    LeashAccountV4 internal chainB;
    MockERC20 internal usdA;
    MockERC20 internal usdB;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal session = makeAddr("session");
    address internal attacker = makeAddr("attacker");

    bytes4 constant SEL_TRANSFER = 0xa9059cbb;
    uint64 constant DELAY = 15 minutes;

    function _policy() internal view returns (LeashAccountV4.Policy memory) {
        return LeashAccountV4.Policy({
            perTransferCap: 1 ether,
            windowCap: 3 ether,
            windowSeconds: 1 hours,
            expiresAt: uint64(block.timestamp + 30 days)
        });
    }

    function _mk(MockERC20 usd) internal returns (LeashAccountV4 a) {
        address[] memory list = new address[](0);
        a = new LeashAccountV4(
            owner, guardian, session, _policy(), list, DELAY, address(usd), LeashAccountV4.TokenPolicy(100e6, 250e6)
        );
        usd.mint(address(a), 1_000e6);
    }

    function setUp() public {
        vm.warp(1_700_000_000);
        usdA = new MockERC20("USD", "USD", 6);
        usdB = new MockERC20("USD", "USD", 6);
        chainA = _mk(usdA);
        chainB = _mk(usdB);
    }

    /// Attacker-chosen bytes: transfer USD to the attacker (recipient NOT self).
    /// Under a standing rule this is refused (RecipientNotSelf); the owner
    /// approves it ONCE on chain A via authorizeOnce (full arg authority).
    function test_oneShot_authorizedOnA_cannotReplayOnB() public {
        // NOTE: token addresses differ per chain in this harness; to isolate the
        // replay question we target the SAME token address on both by using usdA
        // on both accounts' bytes. What matters is the callHash + storage slot.
        bytes memory data = abi.encodeWithSelector(SEL_TRANSFER, attacker, uint256(10e6));
        bytes4 selector = bytes4(data);
        bytes32 callHash = keccak256(abi.encode(block.chainid, address(usdA), selector, data, uint256(0)));

        // Owner authorizes the one-shot ONLY on chain A.
        vm.prank(owner);
        chainA.authorizeOnce(callHash, uint64(block.timestamp + 100));

        // Fund chainA account with usdA and chainB account with usdA too so the
        // token contract exists for both calls (same address is the premise).
        usdA.mint(address(chainA), 1_000e6);
        usdA.mint(address(chainB), 1_000e6);

        // (A) The session key consumes the one-shot on chain A — succeeds, and
        // funds leave to the attacker per the OWNER's explicit approval.
        vm.prank(session);
        chainA.executeCall(address(usdA), 0, data);
        assertEq(usdA.balanceOf(attacker), 10e6, "chainA one-shot consumed per owner authority");

        // (B) The IDENTICAL bytes on chain B: same callHash, but chainB storage
        // has oneShotAuthEta[callHash]==0 and NO active CallRule → the wall
        // refuses. The authorization on A did not leak to B.
        vm.prank(session);
        vm.expectRevert(); // NoActiveCallRule / RuleNotAllowed — not a one-shot
        chainB.executeCall(address(usdA), 0, data);
        assertEq(usdA.balanceOf(attacker), 10e6, "no cross-chain replay: attacker got nothing extra from B");
    }

    /// Consume-once on the SAME chain (delete-on-use) — a second submit of the
    /// exact bytes is refused even on the authorizing chain.
    function test_oneShot_consumeOnce_sameChain() public {
        usdA.mint(address(chainA), 1_000e6);
        bytes memory data = abi.encodeWithSelector(SEL_TRANSFER, attacker, uint256(5e6));
        bytes32 callHash = keccak256(abi.encode(block.chainid, address(usdA), bytes4(data), data, uint256(0)));
        vm.prank(owner);
        chainA.authorizeOnce(callHash, uint64(block.timestamp + 100));
        vm.prank(session);
        chainA.executeCall(address(usdA), 0, data);
        vm.prank(session);
        vm.expectRevert();
        chainA.executeCall(address(usdA), 0, data);
        assertEq(usdA.balanceOf(attacker), 5e6, "one-shot consumed exactly once");
    }

    /// SE-9 carry #4: a one-shot authorized with a callHash computed for a FOREIGN
    /// chainId can never be consumed here — the wall recomputes the hash with the
    /// LIVE `block.chainid`, so a cross-chain-authorized hash simply does not exist
    /// in `oneShotAuthEta` and the call falls through to the standing wall (refused).
    function test_oneShot_chainIdBound_foreignChainHash_refused() public {
        usdA.mint(address(chainA), 1_000e6);
        bytes memory data = abi.encodeWithSelector(SEL_TRANSFER, attacker, uint256(7e6));
        // a hash computed as if for a DIFFERENT chain (block.chainid + 1)
        bytes32 foreignHash = keccak256(abi.encode(block.chainid + 1, address(usdA), bytes4(data), data, uint256(0)));
        vm.prank(owner);
        chainA.authorizeOnce(foreignHash, uint64(block.timestamp + 100));
        // the live-chain hash differs → the one-shot is not found → standing wall refuses.
        vm.prank(session);
        vm.expectRevert();
        chainA.executeCall(address(usdA), 0, data);
        assertEq(usdA.balanceOf(attacker), 0, "foreign-chain one-shot hash never consumable here");
    }
}
