// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {LeashAccountV4} from "../src/LeashAccountV4.sol";
import {MockERC20} from "../src/MockERC20.sol";
import {MockRouter} from "../src/MockRouter.sol";
import {MockAggregatorV3} from "../src/MockAggregatorV3.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// RH slice — the oracle-aware PRICE-BAND wall branch. The agent buys a tokenized
/// stock (sTSLA) paying a quote token (sUSD); the wall reads a Chainlink-shaped feed
/// and reverts a premium or a stale/invalid/down feed (four fail-closed predicates).
/// Both tokens are 18dp so the implied-price math is 1:1 with the stated min-out; the
/// oracle is 8dp (normalized ×1e10). MockRouter is a 1:1 mover — the PRICE semantics
/// live entirely in the wall's amountIn/amountOutMin interpretation (honest mock).
contract LeashAccountV4PriceBandTest is Test {
    LeashAccountV4 internal acct;
    MockERC20 internal susd; // quote token the agent pays (18dp)
    MockERC20 internal stsla; // the priced stock the agent buys (18dp)
    MockRouter internal router;
    MockAggregatorV3 internal feed; // 8dp equity feed, TSLA = $100

    address internal owner = makeAddr("owner");
    address internal session = makeAddr("session");

    bytes4 constant SEL_SWAP = MockRouter.swap.selector;
    uint32 constant BAND_BPS = 500; // 5%
    uint64 constant MAX_STALE = 1 hours;
    int256 constant TSLA_8DP = 100e8; // $100 at 8 decimals

    function setUp() public {
        vm.warp(1_700_000_000);
        susd = new MockERC20("Synthetic USD", "sUSD", 18);
        stsla = new MockERC20("Synthetic TSLA", "sTSLA", 18);
        router = new MockRouter();
        feed = new MockAggregatorV3(TSLA_8DP);

        LeashAccountV4.Policy memory pol = LeashAccountV4.Policy({
            perTransferCap: 1 ether,
            windowCap: 10 ether,
            windowSeconds: 1 hours,
            expiresAt: uint64(block.timestamp + 30 days)
        });
        address[] memory list = new address[](0);
        // timelockDelay = 0 so grants apply instantly (mirrors the testnet drill account).
        acct = new LeashAccountV4(
            owner, owner, session, pol, list, 0, address(susd), LeashAccountV4.TokenPolicy(1, 1)
        );

        // Fund: account holds sUSD to spend; router holds sTSLA to pay out (1:1).
        susd.mint(address(acct), 10_000e18);
        stsla.mint(address(router), 10_000e18);
        // Pre-approve the router from the account (setup convenience — approve
        // governance is covered by the Stage-D suite; this test targets the band).
        vm.prank(address(acct));
        susd.approve(address(router), type(uint256).max);

        // Grant the swap rule (chargeable == value == 0 for a non-structured selector).
        vm.startPrank(owner);
        acct.proposeCallRule(address(router), SEL_SWAP, 0, new address[](0), type(uint128).max, type(uint128).max, bytes32(0));
        acct.applyCallRule();
        // Add the price band (tighten = instant: a fresh band is a new restriction).
        acct.tightenPriceBand(address(router), SEL_SWAP, address(feed), address(stsla), BAND_BPS, MAX_STALE);
        vm.stopPrank();
    }

    function _swap(uint256 amountIn, uint256 amountOutMin) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            SEL_SWAP, address(susd), address(stsla), amountIn, amountOutMin, address(acct), block.timestamp + 1
        );
    }

    function _call(bytes memory data) internal {
        vm.prank(session);
        acct.executeCall(address(router), 0, data);
    }

    // ---- happy: an in-band trade clears ----
    function test_inBandSwap_succeeds() public {
        // 100 sUSD for 1 sTSLA → implied $100 == oracle → in band.
        _call(_swap(100e18, 1e18));
        assertEq(stsla.balanceOf(address(acct)), 100e18); // 1:1 mock payout
    }

    function test_atExactBandEdge_succeeds() public {
        // implied $105 == oracle*(1+5%) → NOT greater → passes.
        _call(_swap(105e18, 1e18));
    }

    // ---- hero: a premium trade is reverted on-chain ----
    function test_premiumSwap_reverts() public {
        // 130 sUSD for 1 sTSLA → implied $130 > $105 band → PremiumBreach.
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.PremiumBreach.selector, uint256(130e18), uint256(105e18)));
        acct.executeCall(address(router), 0, _swap(130e18, 1e18));
    }

    function test_justOverBandEdge_reverts() public {
        vm.prank(session);
        vm.expectRevert();
        acct.executeCall(address(router), 0, _swap(105e18 + 1, 1e18));
    }

    function test_zeroMinOut_failsClosed() public {
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.PremiumBreach.selector, type(uint256).max, uint256(0)));
        acct.executeCall(address(router), 0, _swap(100e18, 0));
    }

    // ---- FOUR fail-closed oracle predicates ----
    function test_predicate1_feedReverts_failsClosed() public {
        feed.setRevert(true);
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.OracleCallFailed.selector);
        acct.executeCall(address(router), 0, _swap(100e18, 1e18));
    }

    function test_predicate2_zeroAnswer_failsClosed() public {
        feed.setAnswer(0);
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.OraclePriceInvalid.selector);
        acct.executeCall(address(router), 0, _swap(100e18, 1e18));
    }

    function test_predicate2_negativeAnswer_failsClosed() public {
        feed.setAnswer(-1);
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.OraclePriceInvalid.selector);
        acct.executeCall(address(router), 0, _swap(100e18, 1e18));
    }

    function test_predicate3_staleFeed_failsClosed() public {
        feed.setStale(2 hours); // older than MAX_STALE
        vm.prank(session);
        vm.expectRevert();
        acct.executeCall(address(router), 0, _swap(100e18, 1e18));
    }

    function test_predicate4_incompleteRound_failsClosed() public {
        feed.setRoundMismatch(); // answeredInRound < roundId
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.OraclePriceInvalid.selector);
        acct.executeCall(address(router), 0, _swap(100e18, 1e18));
    }

    // ---- the band only governs buying the priced asset ----
    function test_assetMismatch_reverts() public {
        // tokenOut = sUSD (not the priced asset sTSLA) → refused.
        bytes memory data = abi.encodeWithSelector(
            SEL_SWAP, address(stsla), address(susd), 100e18, 1e18, address(acct), block.timestamp + 1
        );
        vm.prank(session);
        vm.expectRevert(
            abi.encodeWithSelector(LeashAccountV4.PriceBandAssetMismatch.selector, address(stsla), address(susd))
        );
        acct.executeCall(address(router), 0, data);
    }

    // ---- no regression: a rule with NO band ignores price entirely ----
    function test_noBand_ignoresPrice() public {
        // Deploy a second router rule with no band → a wild premium still clears.
        MockRouter r2 = new MockRouter();
        stsla.mint(address(r2), 10_000e18);
        vm.prank(address(acct));
        susd.approve(address(r2), type(uint256).max);
        vm.startPrank(owner);
        acct.proposeCallRule(address(r2), SEL_SWAP, 0, new address[](0), type(uint128).max, type(uint128).max, bytes32(0));
        acct.applyCallRule();
        vm.stopPrank();
        vm.prank(session);
        acct.executeCall(address(r2), 0, _swap(999e18, 1e18)); // absurd premium, no band → clears
    }

    // ---- governance: tighten instant, loosen timelocked ----
    function test_tightenBand_rejectsLoosening() public {
        vm.prank(owner);
        vm.expectRevert(LeashAccountV4.NotTightening.selector);
        acct.tightenPriceBand(address(router), SEL_SWAP, address(feed), address(stsla), BAND_BPS + 1, MAX_STALE);
    }

    function test_tightenBand_lowersBand() public {
        vm.prank(owner);
        acct.tightenPriceBand(address(router), SEL_SWAP, address(feed), address(stsla), 100, MAX_STALE); // 1%
        // now $105 implied > $101 max → reverts.
        vm.prank(session);
        vm.expectRevert();
        acct.executeCall(address(router), 0, _swap(105e18, 1e18));
    }

    function test_bandOnlyForSwapSelector_reverts() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.BandOnlyForSwap.selector, bytes4(0x095ea7b3)));
        acct.tightenPriceBand(address(router), 0x095ea7b3, address(feed), address(stsla), BAND_BPS, MAX_STALE);
    }
}
