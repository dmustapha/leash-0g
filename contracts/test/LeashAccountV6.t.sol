// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {LeashAccountV6} from "../src/LeashAccountV6.sol";
import {LeashEnvelopeModuleV6} from "../src/LeashEnvelopeModuleV6.sol";
import {PolicyLib} from "../src/PolicyLib.sol";
import {DecodeLib} from "../src/DecodeLib.sol";
import {SigningLib} from "../src/SigningLib.sol";
import {MockERC20} from "../src/MockERC20.sol";

/// AQ-FND ⑤ — the LeashAccountV6 gate suite (AQ-FND-SPEC.md §4):
///   G-1 cap-independence (NON-strict, == allowed) · G-2 sliding-window boundary burst on
///   ALL THREE money paths · G-3 token-unit caps (no oracle) · G-4 approve counted against
///   the asset window · G-5 (target,selector) never bare target · G-6 envelope attenuation
///   both directions (module) · G-7 instant tighten / timelocked widen / immutable delays.
contract LeashAccountV6Test is Test {
    LeashAccountV6 internal acct;
    LeashEnvelopeModuleV6 internal mod;
    PolicyLib internal plib;
    MockERC20 internal usd;
    MockERC20 internal novel;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal session = makeAddr("session");
    address internal payee = makeAddr("payee");
    address internal stranger = makeAddr("stranger");

    uint32 constant W = 1 hours;
    uint64 constant DELAY = 15 minutes;
    uint64 constant VETO = 5 minutes;
    bytes4 constant SEL_APPROVE = 0x095ea7b3;
    bytes4 constant SEL_TRANSFER = 0xa9059cbb;

    function _native(uint128 ptc, uint128 wc) internal pure returns (PolicyLib.AssetPolicy memory) {
        return PolicyLib.AssetPolicy({enabled: true, perTransferCap: ptc, windowCap: wc, windowSeconds: W});
    }

    function _cfg() internal returns (LeashAccountV6.InitConfig memory c) {
        address[] memory assets = new address[](1);
        assets[0] = address(usd);
        PolicyLib.AssetPolicy[] memory pols = new PolicyLib.AssetPolicy[](1);
        pols[0] = _native(10 ether, 30 ether);
        address[] memory list = new address[](1);
        list[0] = payee;
        c = LeashAccountV6.InitConfig({
            owner: owner,
            guardian: guardian,
            sessionKey: session,
            session: PolicyLib.SessionPolicy({ruleWindowSeconds: W, expiresAt: uint64(block.timestamp + 30 days)}),
            nativePolicy: _native(1 ether, 3 ether),
            initialAssets: assets,
            initialAssetPolicies: pols,
            initialAllowlist: list,
            timelockDelay: DELAY,
            signingHelper: address(new SigningLib()),
            decodeHelper: address(new DecodeLib()),
            policyHelper: address(plib),
            envelopeModule: address(mod)
        });
    }

    function setUp() public {
        vm.warp(1_700_000_000);
        usd = new MockERC20("Test USD", "TUSD", 18);
        novel = new MockERC20("Novel", "NOV", 18);
        plib = new PolicyLib();
        mod = new LeashEnvelopeModuleV6();
        acct = new LeashAccountV6(_cfg());
        vm.deal(address(acct), 100 ether);
        usd.mint(address(acct), 1_000 ether);
        novel.mint(address(acct), 1_000 ether);
        // veto config: 5-min veto window, sharp above 50% of ceiling
        vm.prank(owner);
        mod.propose(address(acct), 2, abi.encode(LeashEnvelopeModuleV6.VetoConfig(true, VETO, 5000)));
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        mod.apply_(address(acct), 2, abi.encode(LeashEnvelopeModuleV6.VetoConfig(true, VETO, 5000)));
    }

    function _proposeAsset(address asset, PolicyLib.AssetPolicy memory p) internal {
        bytes memory payload = abi.encode(asset, p);
        vm.prank(owner);
        acct.proposeGoverned(1, payload);
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applyGoverned(1, payload);
    }

    function _setEnvelope(address asset, uint128 maxPtc, uint128 maxWc) internal {
        bytes memory payload = abi.encode(asset, PolicyLib.EnvelopeEntry(true, maxPtc, maxWc, W));
        vm.prank(owner);
        mod.propose(address(acct), 1, payload);
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        mod.apply_(address(acct), 1, payload);
    }

    // ================= G-1 — cap-independence invariant (NON-strict) =================

    function test_G1_windowBelowPerTransfer_rejected_atPropose() public {
        bytes memory payload = abi.encode(address(novel), PolicyLib.AssetPolicy(true, 2 ether, 1 ether, W));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolicyLib.CapInvariant.selector, 1 ether, 2 ether));
        acct.proposeGoverned(1, payload);
    }

    function test_G1_windowEqualPerTransfer_ALLOWED() public {
        // the deliberate one-max-transfer-per-window envelope — a strict > would brick this
        _proposeAsset(address(novel), PolicyLib.AssetPolicy(true, 5 ether, 5 ether, W));
        (bool enabled,,,) = acct.assetPolicy(address(novel));
        assertTrue(enabled);
    }

    function test_G1_constructor_rejects_inverted_caps() public {
        LeashAccountV6.InitConfig memory c = _cfg();
        c.nativePolicy = PolicyLib.AssetPolicy(true, 2 ether, 1 ether, W);
        vm.expectRevert(abi.encodeWithSelector(PolicyLib.CapInvariant.selector, 1 ether, 2 ether));
        new LeashAccountV6(c);
    }

    // ================= G-2 — sliding window kills the boundary burst (3 paths) =================

    /// V5's tumbling counter allowed full-cap at t=W−1 then full-cap again at t=W+1 (2× burst).
    /// The two-bucket slide must refuse the second spend.
    function test_G2_nativeExecute_boundaryBurst_refused() public {
        vm.warp(block.timestamp + W - 1); // near the window edge
        vm.prank(session);
        acct.execute(payee, 1 ether, ""); // windowCap 3: spend 1 (perTransferCap 1)
        vm.prank(session);
        acct.execute(payee, 1 ether, "");
        vm.prank(session);
        acct.execute(payee, 1 ether, ""); // cap reached
        vm.warp(block.timestamp + 2); // just past the boundary — tumbling would reset here
        vm.prank(session);
        vm.expectRevert(); // OverWindowCap from PolicyLib.slide: prev-bucket estimate still ≈ cap
        acct.execute(payee, 1 ether, "");
    }

    function test_G2_tokenTransfer_boundaryBurst_refused() public {
        vm.warp(block.timestamp + W - 1);
        vm.startPrank(session);
        acct.executeTokenTransfer(address(usd), payee, 10 ether);
        acct.executeTokenTransfer(address(usd), payee, 10 ether);
        acct.executeTokenTransfer(address(usd), payee, 10 ether); // 30 = windowCap
        vm.stopPrank();
        vm.warp(block.timestamp + 2);
        vm.prank(session);
        vm.expectRevert();
        acct.executeTokenTransfer(address(usd), payee, 10 ether);
    }

    function test_G2_slidingDecay_allowsSpend_asPrevBucketAges() public {
        // fresh asset → its meter anchors at apply time, so offsets below are exact
        _proposeAsset(address(novel), PolicyLib.AssetPolicy(true, 10 ether, 30 ether, W));
        // via-IR reschedules a raw block.timestamp read across vm.warp cheatcodes (it assumes
        // TIMESTAMP is call-constant) — snapshot through the cheatcode instead.
        uint256 anchor = vm.getBlockTimestamp(); // the fresh meter's bucket-0 start
        bytes memory payload = abi.encode(address(novel), payee);
        vm.prank(owner);
        acct.proposeGoverned(4, payload);
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applyGoverned(4, payload);
        vm.startPrank(session);
        acct.executeTokenTransfer(address(novel), payee, 10 ether);
        acct.executeTokenTransfer(address(novel), payee, 10 ether);
        acct.executeTokenTransfer(address(novel), payee, 10 ether); // full 30 cap in this bucket
        vm.stopPrank();
        // mid-point of the meter's NEXT bucket: carried = 30·(W−W/2)/W = 15
        vm.warp(anchor + W + W / 2);
        vm.prank(session);
        acct.executeTokenTransfer(address(novel), payee, 10 ether); // carried+10 ≤ 30 ✓
        vm.prank(session);
        vm.expectRevert();
        acct.executeTokenTransfer(address(novel), payee, 10 ether); // carried+20 > 30 ✗
    }

    function test_G2_governedPath_boundaryBurst_refused() public {
        // the third money path: executeCall's chargeable debits the same sliding meter
        _grantRule(address(usd), SEL_TRANSFER, 1, 30 ether, 90 ether);
        vm.warp(block.timestamp + W - 1);
        vm.prank(session);
        acct.executeCall(address(usd), 0, abi.encodeWithSelector(SEL_TRANSFER, payee, 30 ether)); // full asset cap
        vm.warp(block.timestamp + 2);
        vm.prank(session);
        vm.expectRevert();
        acct.executeCall(address(usd), 0, abi.encodeWithSelector(SEL_TRANSFER, payee, 30 ether));
    }

    // ================= G-3 — token-unit caps, no oracle =================

    function test_G3_capBindsInTokenUnits() public {
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV6.OverPerTransferCap.selector, 11 ether, uint128(10 ether)));
        acct.executeTokenTransfer(address(usd), payee, 11 ether); // 10-token per-transfer cap, token units
    }

    // ================= G-4 — approve COUNTED against the asset window =================

    function test_G4_approve_debits_assetWindow() public {
        _grantRuleWithSpender(address(usd), SEL_APPROVE, stranger, 30 ether, 90 ether);
        vm.prank(session);
        acct.executeCall(address(usd), 0, abi.encodeWithSelector(SEL_APPROVE, stranger, 25 ether));
        // 25 of the 30 window is consumed by the APPROVAL — a transfer of 10 must now fail
        vm.prank(session);
        vm.expectRevert();
        acct.executeTokenTransfer(address(usd), payee, 10 ether);
        // and 5 still fits
        vm.prank(session);
        acct.executeTokenTransfer(address(usd), payee, 5 ether);
    }

    function test_G4_capExhausted_cannotApprove() public {
        _grantRuleWithSpender(address(usd), SEL_APPROVE, stranger, 30 ether, 90 ether);
        vm.startPrank(session);
        acct.executeTokenTransfer(address(usd), payee, 10 ether);
        acct.executeTokenTransfer(address(usd), payee, 10 ether);
        acct.executeTokenTransfer(address(usd), payee, 10 ether); // window exhausted
        vm.expectRevert();
        acct.executeCall(address(usd), 0, abi.encodeWithSelector(SEL_APPROVE, stranger, 1 ether));
        vm.stopPrank();
    }

    // ================= G-5 — (target, selector), never bare target =================

    function test_G5_bareTarget_refused() public {
        // allowlist the TARGET via a transfer rule, then call a DIFFERENT selector on it
        _grantRule(address(usd), SEL_TRANSFER, 1, 10 ether, 30 ether);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV6.SelectorNotAllowlisted.selector, SEL_APPROVE));
        acct.executeCall(address(usd), 0, abi.encodeWithSelector(SEL_APPROVE, stranger, 1 ether));
    }

    // ================= G-6 — envelope attenuation, both directions (module) =================

    function test_G6_outsideEnvelope_refusedOnChain() public {
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashEnvelopeModuleV6.OutsideEnvelope.selector, address(novel)));
        mod.agentEnableAsset(address(acct), PolicyLib.AssetPolicy(true, 1 ether, 2 ether, W), address(novel));
    }

    function test_G6_insideEnvelope_belowSharp_instant() public {
        _setEnvelope(address(novel), 5 ether, 20 ether);
        // 8 ≤ 50% of 20 → not sharp → instant, no owner click
        vm.prank(session);
        mod.agentEnableAsset(address(acct), PolicyLib.AssetPolicy(true, 2 ether, 8 ether, W), address(novel));
        (bool enabled, uint128 ptc,,) = acct.assetPolicy(address(novel));
        assertTrue(enabled);
        assertEq(ptc, 2 ether);
        // and it can spend immediately (payee already known on other assets? payee is known —
        // but novel's OWN allowlist is empty; agent adds the known payee instantly)
        vm.prank(session);
        mod.agentAddPayee(address(acct), address(novel), payee);
        vm.prank(session);
        acct.executeTokenTransfer(address(novel), payee, 1 ether);
    }

    function test_G6_capsAboveCeiling_refused() public {
        _setEnvelope(address(novel), 5 ether, 20 ether);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashEnvelopeModuleV6.OutsideEnvelope.selector, address(novel)));
        mod.agentEnableAsset(address(acct), PolicyLib.AssetPolicy(true, 6 ether, 20 ether, W), address(novel));
    }

    function test_G6_sharpMove_queues_vetoable() public {
        _setEnvelope(address(novel), 5 ether, 20 ether);
        // 15 > 50% of 20 → sharp → queued behind the veto window
        PolicyLib.AssetPolicy memory p = PolicyLib.AssetPolicy(true, 5 ether, 15 ether, W);
        vm.prank(session);
        mod.agentEnableAsset(address(acct), p, address(novel));
        (bool enabled,,,) = acct.assetPolicy(address(novel));
        assertFalse(enabled); // not yet applied
        // owner vetoes — INSTANT
        vm.prank(owner);
        mod.vetoAgentAction(address(acct));
        vm.warp(block.timestamp + VETO + 1);
        vm.prank(session);
        vm.expectRevert(LeashEnvelopeModuleV6.NoAgentActionPending.selector);
        mod.agentApplyQueued(address(acct), 1, address(novel), p, address(0));
    }

    function test_G6_sharpMove_unvetoed_appliesAfterWindow() public {
        _setEnvelope(address(novel), 5 ether, 20 ether);
        PolicyLib.AssetPolicy memory p = PolicyLib.AssetPolicy(true, 5 ether, 15 ether, W);
        vm.prank(session);
        mod.agentEnableAsset(address(acct), p, address(novel));
        vm.warp(block.timestamp + VETO + 1);
        vm.prank(session);
        mod.agentApplyQueued(address(acct), 1, address(novel), p, address(0));
        (bool enabled,, uint128 wc,) = acct.assetPolicy(address(novel));
        assertTrue(enabled);
        assertEq(wc, 15 ether);
    }

    function test_G6_neverSeenPayee_queues() public {
        _setEnvelope(address(usd), 10 ether, 30 ether);
        vm.prank(session);
        mod.agentAddPayee(address(acct), address(usd), stranger); // never allowlisted anywhere
        assertFalse(acct.allowlist(address(usd), stranger)); // queued, not applied
        vm.warp(block.timestamp + VETO + 1);
        vm.prank(session);
        mod.agentApplyQueued(address(acct), 2, address(usd), PolicyLib.AssetPolicy(false, 0, 0, 0), stranger);
        assertTrue(acct.allowlist(address(usd), stranger));
    }

    function test_G6_moduleGate_strangerCannotWrite() public {
        vm.prank(stranger);
        vm.expectRevert(LeashAccountV6.NotEnvelopeModule.selector);
        acct.moduleSetAssetPolicy(address(novel), PolicyLib.AssetPolicy(true, 1 ether, 2 ether, W));
    }

    function test_G6_ownerTightensEnvelope_midWindow_applyRefused() public {
        _setEnvelope(address(novel), 5 ether, 20 ether);
        PolicyLib.AssetPolicy memory p = PolicyLib.AssetPolicy(true, 5 ether, 15 ether, W);
        vm.prank(session);
        mod.agentEnableAsset(address(acct), p, address(novel));
        // mid-window the owner shrinks the ceiling below the queued ask — INSTANT
        vm.prank(owner);
        mod.tightenEnvelope(address(acct), address(novel), PolicyLib.EnvelopeEntry(true, 5 ether, 10 ether, W));
        vm.warp(block.timestamp + VETO + 1);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashEnvelopeModuleV6.OutsideEnvelope.selector, address(novel)));
        mod.agentApplyQueued(address(acct), 1, address(novel), p, address(0));
    }

    // ================= G-7 — instant tighten · timelocked widen · immutable delays =================

    function test_G7_disableAsset_instant_blocksAllPaths() public {
        vm.prank(owner);
        acct.disableAsset(address(usd));
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV6.TokenNotAllowlisted.selector, address(usd)));
        acct.executeTokenTransfer(address(usd), payee, 1 ether);
    }

    function test_G7_guardian_canDisable() public {
        vm.prank(guardian);
        acct.disableAsset(address(usd));
        (bool enabled,,,) = acct.assetPolicy(address(usd));
        assertFalse(enabled);
    }

    function test_G7_widen_isTimelocked() public {
        bytes memory payload = abi.encode(address(usd), PolicyLib.AssetPolicy(true, 20 ether, 60 ether, W));
        vm.prank(owner);
        acct.proposeGoverned(1, payload);
        vm.prank(owner);
        vm.expectRevert(); // TimelockNotElapsed
        acct.applyGoverned(1, payload);
    }

    function test_G7_revoke_instant_killsSpend_andModuleWrites() public {
        vm.prank(guardian);
        acct.revoke();
        vm.prank(session);
        vm.expectRevert(LeashAccountV6.AccountRevoked.selector);
        acct.executeTokenTransfer(address(usd), payee, 1 ether);
        // the module cannot write into a revoked account (D beats the module)
        vm.prank(address(mod));
        vm.expectRevert(LeashAccountV6.AccountRevoked.selector);
        acct.moduleSetAssetPolicy(address(novel), PolicyLib.AssetPolicy(true, 1 ether, 2 ether, W));
    }

    function test_G7_tighten_instant_bySession_tooAttenuation() public {
        // the agent narrows its own authority through the same path (attenuation law)
        vm.prank(session);
        acct.tightenAssetPolicy(address(usd), PolicyLib.AssetPolicy(true, 5 ether, 20 ether, W));
        (, uint128 ptc, uint128 wc,) = acct.assetPolicy(address(usd));
        assertEq(ptc, 5 ether);
        assertEq(wc, 20 ether);
    }

    function test_G7_sessionCannotWiden_viaTighten() public {
        vm.prank(session);
        vm.expectRevert(PolicyLib.NotTightening.selector);
        acct.tightenAssetPolicy(address(usd), PolicyLib.AssetPolicy(true, 20 ether, 60 ether, W));
    }

    // ================= hold-vs-spend floor + commit integrity =================

    function test_holdVsSpend_novelToken_cannotMove_untilGoverned() public {
        // the account HOLDS novel (minted in setUp) — holding needed no registration;
        // spending reverts until a policy exists (the on-chain floor the ask rides on)
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV6.TokenNotAllowlisted.selector, address(novel)));
        acct.executeTokenTransfer(address(novel), payee, 1 ether);
    }

    function test_commitMismatch_applyDifferentPayload_refused() public {
        vm.prank(owner);
        acct.proposeGoverned(1, abi.encode(address(novel), PolicyLib.AssetPolicy(true, 1 ether, 2 ether, W)));
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert(LeashAccountV6.CommitMismatch.selector);
        acct.applyGoverned(1, abi.encode(address(novel), PolicyLib.AssetPolicy(true, 10 ether, 20 ether, W)));
    }

    // ================= helpers =================

    function _grantRule(address target, bytes4 sel, uint8 mode, uint128 pcc, uint128 wcc) internal {
        vm.prank(owner);
        acct.proposeCallRule(target, sel, mode, new address[](0), pcc, wcc, bytes32(0));
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applyCallRule();
    }

    function _grantRuleWithSpender(address target, bytes4 sel, address spender, uint128 pcc, uint128 wcc) internal {
        address[] memory sp = new address[](1);
        sp[0] = spender;
        vm.prank(owner);
        acct.proposeCallRule(target, sel, 0, sp, pcc, wcc, bytes32(0));
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applyCallRule();
    }
}
