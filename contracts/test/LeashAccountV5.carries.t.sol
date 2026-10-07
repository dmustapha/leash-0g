// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {LeashAccountV5} from "../src/LeashAccountV5.sol";
import {LeashAccountV4} from "../src/LeashAccountV4.sol";
import {LeashAccountV5FactoryDeterministic} from "../src/LeashAccountV5FactoryDeterministic.sol";
import {MockERC20} from "../src/MockERC20.sol";
import {MockRouter} from "../src/MockRouter.sol";
import {MockAggregatorV3} from "../src/MockAggregatorV3.sol";

/// Stage F′ FP-1 — the four FP-CARRY V5 hardening items + the CREATE2/version
/// factory (FP-g). These land in the NEW immutable V5, never a V4 redeploy.
contract LeashAccountV5CarriesTest is Test {
    LeashAccountV5 internal acct;
    MockERC20 internal usd; // 18dp
    MockERC20 internal tokenOut18; // 18dp swap output
    MockRouter internal router;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal session = makeAddr("session");
    address internal attacker = makeAddr("attacker");

    uint32 constant WINDOW_SECONDS = 1 hours;
    uint64 constant DELAY = 15 minutes;
    bytes4 constant SEL_SWAP = 0x9908fc8b; // swap(address,address,uint256,uint256,address,uint256)
    bytes4 constant SEL_TRANSFER = 0xa9059cbb;

    function _policy() internal view returns (LeashAccountV5.Policy memory) {
        return LeashAccountV5.Policy({
            perTransferCap: 1 ether,
            windowCap: 3 ether,
            windowSeconds: WINDOW_SECONDS,
            expiresAt: uint64(block.timestamp + 30 days)
        });
    }

    function setUp() public {
        vm.warp(1_700_000_000);
        usd = new MockERC20("Test USD 18", "TUSD18", 18);
        tokenOut18 = new MockERC20("Out 18", "OUT18", 18);
        router = new MockRouter();
        address[] memory list = new address[](0);
        acct = new LeashAccountV5(
            owner, guardian, session, _policy(), list, DELAY, address(usd), LeashAccountV5.TokenPolicy(0, 0)
        );
        usd.mint(address(acct), 1_000 ether);
    }

    function _grant(address target, bytes4 sel, uint8 mode, uint128 pcc, uint128 wcc) internal {
        vm.prank(owner);
        acct.proposeCallRule(target, sel, mode, new address[](0), pcc, wcc, bytes32(0));
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

    function _swapData(address tokenIn, address tOut, uint256 amountIn, uint256 minOut, address recipient)
        internal
        view
        returns (bytes memory)
    {
        return abi.encodeWithSelector(SEL_SWAP, tokenIn, tOut, amountIn, minOut, recipient, block.timestamp + 1);
    }

    // ============ FP-CARRY-1: swap recipient pinned + amountIn budgeted ON-CHAIN ============

    function test_CARRY1_swapRecipientRedirect_reverts() public {
        _budget(address(usd), 500 ether);
        _grant(address(router), SEL_SWAP, 0, 200 ether, 400 ether); // mode 0 → recipient must be self
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV5.RecipientNotSelf.selector, attacker));
        acct.executeCall(address(router), 0, _swapData(address(usd), address(tokenOut18), 10 ether, 1, attacker));
    }

    function test_CARRY1_swapAmountInChargesTokenInBudget() public {
        _budget(address(usd), 500 ether);
        _grant(address(router), SEL_SWAP, 0, 200 ether, 400 ether);
        // make the swap actually settle so the pre-call budget debit persists:
        // give the router output liquidity and let the account pre-approve the pull.
        tokenOut18.mint(address(router), 1_000 ether);
        vm.prank(address(acct));
        usd.approve(address(router), type(uint256).max);
        vm.prank(session);
        acct.executeCall(address(router), 0, _swapData(address(usd), address(tokenOut18), 100 ether, 1, address(acct)));
        (,, uint128 spent,) = acct.spendBudget(address(usd));
        assertEq(spent, 100 ether, "swap amountIn must charge tokenIn's budget on-chain");
    }

    function test_CARRY1_swapOverPerCallCap_reverts() public {
        _budget(address(usd), 500 ether);
        _grant(address(router), SEL_SWAP, 0, 50 ether, 400 ether);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV5.OverPerCallCap.selector, 60 ether, uint128(50 ether)));
        acct.executeCall(address(router), 0, _swapData(address(usd), address(tokenOut18), 60 ether, 1, address(acct)));
    }

    function test_CARRY1_swapOverCumulativeBudget_reverts() public {
        _budget(address(usd), 150 ether);
        _grant(address(router), SEL_SWAP, 0, 100 ether, 1_000 ether);
        // let the first swap settle so its budget debit (100) persists; the second
        // (60) then trips the cumulative budget BEFORE its external call.
        tokenOut18.mint(address(router), 1_000 ether);
        vm.prank(address(acct));
        usd.approve(address(router), type(uint256).max);
        vm.startPrank(session);
        acct.executeCall(address(router), 0, _swapData(address(usd), address(tokenOut18), 100 ether, 1, address(acct)));
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV5.OverCumulativeSpend.selector, 160 ether, uint128(150 ether)));
        acct.executeCall(address(router), 0, _swapData(address(usd), address(tokenOut18), 60 ether, 1, address(acct)));
        vm.stopPrank();
    }

    function test_CARRY1_swapNoBudget_reverts() public {
        _grant(address(router), SEL_SWAP, 0, 200 ether, 400 ether); // no budget set for usd
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV5.BudgetNotSet.selector, address(usd)));
        acct.executeCall(address(router), 0, _swapData(address(usd), address(tokenOut18), 10 ether, 1, address(acct)));
    }

    function test_CARRY1_oneShotSwap_bypassesBudget_additive() public {
        // the owner-reviewed one-shot lane bypasses the standing envelope + budget for a
        // swap (additive, not budget-debited) — unchanged by FP-CARRY-1's structured decode.
        // No grant, no budget: only the one-shot authorization + structural guards apply.
        tokenOut18.mint(address(router), 1_000 ether);
        vm.prank(address(acct));
        usd.approve(address(router), type(uint256).max);
        bytes memory data = _swapData(address(usd), address(tokenOut18), 100 ether, 1, address(acct));
        bytes32 callHash = keccak256(abi.encode(block.chainid, address(router), SEL_SWAP, data, uint256(0)));
        vm.prank(owner);
        acct.authorizeOnce(callHash, uint64(block.timestamp + 100));
        vm.prank(session);
        acct.executeCall(address(router), 0, data); // succeeds with NO budget set
        (bool set,,,) = acct.spendBudget(address(usd));
        assertFalse(set, "one-shot swap must not touch the per-token budget");
    }

    // ============ FP-CARRY-2: band asset must be 18dp ============

    function test_CARRY2_bandAssetNon18dp_reverts() public {
        MockERC20 asset6 = new MockERC20("Six", "SIX", 6);
        MockAggregatorV3 feed = new MockAggregatorV3(2000e8); // 8dp feed (ok)
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV5.AssetNotEighteenDecimals.selector, uint8(6)));
        acct.tightenPriceBand(address(router), SEL_SWAP, address(feed), address(asset6), 500, 1 hours);
    }

    function test_CARRY2_bandAsset18dp_ok() public {
        MockAggregatorV3 feed = new MockAggregatorV3(2000e8);
        vm.prank(owner);
        acct.tightenPriceBand(address(router), SEL_SWAP, address(feed), address(tokenOut18), 500, 1 hours);
        (bool set,,,,) = acct.priceBand(keccak256(abi.encodePacked(address(router), SEL_SWAP)));
        assertTrue(set, "18dp asset band must be accepted");
    }

    // ============ FP-CARRY-4: instant tighten clears ONLY the matching pending slot ============

    function test_CARRY4_tightenBudget_keepsPendingCallRule() public {
        _budget(address(usd), 500 ether);
        // arm a pending call-rule loosening
        vm.prank(owner);
        acct.proposeCallRule(address(router), SEL_TRANSFER, 0, new address[](0), 1 ether, 2 ether, bytes32(0));
        (,,,,,, uint64 etaBefore) = acct.pendingCallRule();
        assertTrue(etaBefore != 0, "call-rule pending armed");
        // a budget tighten (different dimension) must NOT clear the pending call rule
        vm.prank(owner);
        acct.tightenSpendBudget(address(usd), 100 ether);
        (,,,,,, uint64 etaAfter) = acct.pendingCallRule();
        assertEq(etaAfter, etaBefore, "budget tighten must leave the pending call-rule slot intact (FP-CARRY-4)");
    }

    function test_CARRY4_tightenBudget_clearsOwnPendingBudget() public {
        _budget(address(usd), 500 ether);
        vm.prank(owner);
        acct.proposeSpendBudget(address(usd), 900 ether); // pending budget loosening
        assertTrue(acct.pendingBudgetEta() != 0, "budget pending armed");
        vm.prank(owner);
        acct.tightenSpendBudget(address(usd), 100 ether);
        assertEq(acct.pendingBudgetEta(), 0, "a budget tighten clears its OWN pending budget slot");
    }

    function test_CARRY4_revokeStillClearsAll() public {
        _budget(address(usd), 500 ether);
        vm.prank(owner);
        acct.proposeCallRule(address(router), SEL_TRANSFER, 0, new address[](0), 1 ether, 2 ether, bytes32(0));
        vm.prank(owner);
        acct.proposeSpendBudget(address(usd), 900 ether);
        vm.prank(guardian);
        acct.revoke(); // emergency → clears everything (fail-closed)
        (,,,,,, uint64 eta) = acct.pendingCallRule();
        assertEq(eta, 0, "revoke clears pending call rule");
        assertEq(acct.pendingBudgetEta(), 0, "revoke clears pending budget");
    }

    // ============ FP-g: CREATE2 same-address + version-selected factory; V4 untouched ============

    function test_FPg_factoryDeterministicSameAddress() public {
        LeashAccountV5FactoryDeterministic f = new LeashAccountV5FactoryDeterministic();
        address[] memory list = new address[](0);
        bytes32 salt = keccak256("owner-salt");
        address predicted = f.predictAccountV5(
            owner, guardian, session, _policy(), list, DELAY, address(usd), LeashAccountV5.TokenPolicy(0, 0), salt
        );
        address created = f.createAccountV5(
            owner, guardian, session, _policy(), list, DELAY, address(usd), LeashAccountV5.TokenPolicy(0, 0), salt
        );
        assertEq(created, predicted, "CREATE2 deploy must land at the predicted address");
        assertEq(f.ACCOUNT_VERSION_V5(), 5, "version constant must be 5");
    }

    function test_FPg_factoryRedeploy_reverts() public {
        LeashAccountV5FactoryDeterministic f = new LeashAccountV5FactoryDeterministic();
        address[] memory list = new address[](0);
        bytes32 salt = keccak256("owner-salt");
        f.createAccountV5(owner, guardian, session, _policy(), list, DELAY, address(usd), LeashAccountV5.TokenPolicy(0, 0), salt);
        vm.expectRevert();
        f.createAccountV5(owner, guardian, session, _policy(), list, DELAY, address(usd), LeashAccountV5.TokenPolicy(0, 0), salt);
    }

    function test_FPg_v4BytecodeUntouched() public {
        // V4 must NOT implement ERC-1271 (closed by construction, Stage-D invariant);
        // the new signing capability lives ONLY in V5.
        LeashAccountV4 v4 = new LeashAccountV4(
            owner, guardian, session, _v4policy(), new address[](0), DELAY, address(usd), LeashAccountV4.TokenPolicy(0, 0)
        );
        (bool ok,) = address(v4).staticcall(abi.encodeWithSelector(bytes4(0x1626ba7e), bytes32(0), bytes("")));
        assertFalse(ok, "V4 must remain without ERC-1271 (untouched)");
    }

    function _v4policy() internal view returns (LeashAccountV4.Policy memory) {
        return LeashAccountV4.Policy({
            perTransferCap: 1 ether, windowCap: 3 ether, windowSeconds: WINDOW_SECONDS, expiresAt: uint64(block.timestamp + 30 days)
        });
    }
}
