// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {LeashAccountV5} from "../src/LeashAccountV5.sol";
import {DecodeLib} from "../src/DecodeLib.sol";
import {SigningLib} from "../src/SigningLib.sol";
import {MockERC20} from "../src/MockERC20.sol";

/// Stage F′ FP-4 Slice-2 — co-signer SECOND FACTOR activation (`07 #15`; design `FP4-P2-DESIGN.md`).
///
/// When `coSigner != address(0)`, arming a signing intent requires the co-signer's approval over
/// `CoSignerApproval(intentDigest,chainId,account,epoch)` IN ADDITION to the session-key signature.
/// These tests are the build-acceptance proof for the design-gate security requirements SR-1..SR-11.
contract LeashAccountV5CoSignerTest is Test {
    LeashAccountV5 internal acct;
    MockERC20 internal usd;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal session;
    uint256 internal sessionPk;
    address internal coSigner;
    uint256 internal coSignerPk;
    address internal spender = makeAddr("cowSettler");

    uint32 constant WINDOW_SECONDS = 1 hours;
    uint64 constant DELAY = 15 minutes;
    bytes4 constant ERC1271_MAGIC = 0x1626ba7e;
    bytes4 constant ERC1271_INVALID = 0xffffffff;

    uint256 constant DESCRIPTOR_ID = 1;
    bytes32 constant TYPEHASH = keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    uint8 constant NUM_FIELDS = 5;
    uint8 constant SPENDER_IDX = 1;
    uint8 constant AMOUNT_IDX = 2;
    uint8 constant DEADLINE_IDX = 4;
    bytes32 constant CO_TYPEHASH = keccak256("CoSignerApproval(bytes32 intentDigest,uint256 chainId,address account,uint64 epoch)");

    bytes32 internal domainSep;

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
        (session, sessionPk) = makeAddrAndKey("session");
        (coSigner, coSignerPk) = makeAddrAndKey("coSigner");
        usd = new MockERC20("Test USD 18", "TUSD18", 18);
        address[] memory list = new address[](0);
        acct = new LeashAccountV5(
            owner, guardian, session, _policy(), list, DELAY, address(usd),
            LeashAccountV5.TokenPolicy(0, 0), address(new SigningLib()), address(new DecodeLib())
        );
        usd.mint(address(acct), 1_000 ether);
        domainSep = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("CoWProtocol"), keccak256("1"), block.chainid, spender
            )
        );
        _budget(address(usd), 3 ether);
        _grantSigning(address(usd), 1 ether, 1 days, spender);
    }

    // ---------- helpers ----------
    function _spenders(address a) internal pure returns (address[] memory s) {
        s = new address[](1);
        s[0] = a;
    }

    function _grantSigning(address token, uint128 cap, uint64 win, address sp) internal {
        vm.prank(owner);
        acct.proposeSigningGrantNested(
            SigningLib.SigningGrantParams(DESCRIPTOR_ID, domainSep, TYPEHASH, NUM_FIELDS, SPENDER_IDX, AMOUNT_IDX, DEADLINE_IDX, type(uint8).max, bytes32(0), 0, 0, token, cap, win, 0, address(0)),
            _spenders(sp),
            new SigningLib.TokenCap[](0)
        );
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applySigningGrant();
    }

    function _budget(address token, uint128 cap) internal {
        vm.prank(owner);
        acct.proposeSpendBudget(token, cap);
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applySpendBudget();
    }

    function _fields(address sp, uint256 amount, uint256 deadline) internal view returns (bytes32[] memory f) {
        f = new bytes32[](NUM_FIELDS);
        f[0] = bytes32(uint256(uint160(owner)));
        f[1] = bytes32(uint256(uint160(sp)));
        f[2] = bytes32(amount);
        f[3] = bytes32(uint256(7));
        f[4] = bytes32(deadline);
    }

    function _digest(bytes32[] memory f) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", domainSep, keccak256(abi.encodePacked(TYPEHASH, f))));
    }

    function _sign(uint256 pk, bytes32 d) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, d);
        return abi.encodePacked(r, s, v);
    }

    /// A co-signer approval over the given binding tuple.
    function _coApproval(uint256 pk, bytes32 digest, uint256 chainId, address account, uint64 epoch)
        internal
        pure
        returns (bytes memory)
    {
        return _sign(pk, keccak256(abi.encode(CO_TYPEHASH, digest, chainId, account, epoch)));
    }

    /// A correctly-bound co-signer approval for THIS account/chain at the CURRENT epoch.
    function _coNow(uint256 pk, bytes32 digest) internal view returns (bytes memory) {
        return _coApproval(pk, digest, block.chainid, address(acct), acct.signingEpoch());
    }

    function _setCoSigner(address c) internal {
        vm.prank(owner);
        acct.setCoSigner(c);
    }

    function _armRaw(uint256 amount, uint256 deadline, bytes memory coSig) internal returns (bytes32 digest) {
        bytes32[] memory f = _fields(spender, amount, deadline);
        digest = _digest(f);
        vm.prank(session);
        acct.authorizeSigningIntent(DESCRIPTOR_ID, f, new SigningLib.TokenCap[](0), _sign(sessionPk, digest), coSig);
    }

    // ============ SR-9: inert path (coSigner == 0) never enforces ============
    function test_inert_ignoresCoSignerSig() public {
        // No co-signer set → even garbage co-signer bytes are ignored, arm succeeds.
        bytes32 d = _armRaw(0.5 ether, block.timestamp + 1 hours, hex"deadbeef");
        assertEq(acct.isValidSignature(d, ""), ERC1271_MAGIC);
    }

    // ============ SR-6: adding the factor is INSTANT + bumps epoch ============
    function test_add_isInstant_andBumpsEpoch() public {
        uint64 e0 = acct.signingEpoch();
        _setCoSigner(coSigner);
        assertEq(acct.coSigner(), coSigner);
        assertEq(acct.signingEpoch(), e0 + 1, "add must bump epoch");
        assertEq(acct.pendingCoSignerEta(), 0, "instant add leaves nothing pending");
    }

    function test_add_invalidatesInflightSingleFactorArm() public {
        // Arm single-factor, then activate the co-signer: the pre-armed digest must go INVALID (SR-6).
        bytes32 d = _armRaw(0.5 ether, block.timestamp + 1 hours, "");
        assertEq(acct.isValidSignature(d, ""), ERC1271_MAGIC);
        _setCoSigner(coSigner);
        assertEq(acct.isValidSignature(d, ""), ERC1271_INVALID, "stale-epoch arm must fail-closed");
    }

    // ============ active enforcement + SR-4 unconditional ============
    function test_active_requiresValidCoSigner() public {
        _setCoSigner(coSigner);
        bytes32[] memory f = _fields(spender, 0.5 ether, block.timestamp + 1 hours);
        bytes32 d = _digest(f);
        // missing / empty co-signer sig → revert
        vm.prank(session);
        vm.expectRevert(SigningLib.BadCoSignerSignature.selector);
        acct.authorizeSigningIntent(DESCRIPTOR_ID, f, new SigningLib.TokenCap[](0), _sign(sessionPk, d), "");
        // valid co-signer sig → arms (precompute the approval BEFORE the prank — a view call in the
        // argument list would otherwise consume the prank).
        bytes memory co = _coNow(coSignerPk, d);
        vm.prank(session);
        acct.authorizeSigningIntent(DESCRIPTOR_ID, f, new SigningLib.TokenCap[](0), _sign(sessionPk, d), co);
        assertEq(acct.isValidSignature(d, ""), ERC1271_MAGIC);
    }

    function test_active_zeroNotionalStillRequiresCoSigner() public {
        // SR-4: amount==0 (cancel / zero-approval) skips the budget debit but MUST still need the co-signer.
        _setCoSigner(coSigner);
        bytes32[] memory f = _fields(spender, 0, block.timestamp + 1 hours);
        bytes32 d = _digest(f);
        vm.prank(session);
        vm.expectRevert(SigningLib.BadCoSignerSignature.selector);
        acct.authorizeSigningIntent(DESCRIPTOR_ID, f, new SigningLib.TokenCap[](0), _sign(sessionPk, d), "");
        bytes memory co = _coNow(coSignerPk, d);
        vm.prank(session);
        acct.authorizeSigningIntent(DESCRIPTOR_ID, f, new SigningLib.TokenCap[](0), _sign(sessionPk, d), co);
        assertEq(acct.isValidSignature(d, ""), ERC1271_MAGIC);
    }

    function test_active_wrongSignerRejected() public {
        _setCoSigner(coSigner);
        bytes32[] memory f = _fields(spender, 0.5 ether, block.timestamp + 1 hours);
        bytes32 d = _digest(f);
        // the SESSION key signing the co-approval (not the co-signer) must fail.
        bytes memory wrongSigner = _coNow(sessionPk, d);
        vm.prank(session);
        vm.expectRevert(SigningLib.BadCoSignerSignature.selector);
        acct.authorizeSigningIntent(DESCRIPTOR_ID, f, new SigningLib.TokenCap[](0), _sign(sessionPk, d), wrongSigner);
    }

    // ============ SR-1: cross-chain / cross-account binding ============
    function test_SR1_wrongChainIdRejected() public {
        _setCoSigner(coSigner);
        bytes32[] memory f = _fields(spender, 0.5 ether, block.timestamp + 1 hours);
        bytes32 d = _digest(f);
        bytes memory wrong = _coApproval(coSignerPk, d, block.chainid + 1, address(acct), acct.signingEpoch());
        vm.prank(session);
        vm.expectRevert(SigningLib.BadCoSignerSignature.selector);
        acct.authorizeSigningIntent(DESCRIPTOR_ID, f, new SigningLib.TokenCap[](0), _sign(sessionPk, d), wrong);
    }

    function test_SR1_wrongAccountRejected() public {
        _setCoSigner(coSigner);
        bytes32[] memory f = _fields(spender, 0.5 ether, block.timestamp + 1 hours);
        bytes32 d = _digest(f);
        bytes memory wrong = _coApproval(coSignerPk, d, block.chainid, address(0xBEEF), acct.signingEpoch());
        vm.prank(session);
        vm.expectRevert(SigningLib.BadCoSignerSignature.selector);
        acct.authorizeSigningIntent(DESCRIPTOR_ID, f, new SigningLib.TokenCap[](0), _sign(sessionPk, d), wrong);
    }

    function test_SR1_replayOnOtherChainFails() public {
        // A co-signer approval bound to THIS chain must not validate after the chain id changes
        // (same-address CREATE2 account on another chain). Sign here, warp chain, re-submit → reject.
        _setCoSigner(coSigner);
        bytes32[] memory f = _fields(spender, 0.5 ether, block.timestamp + 1 hours);
        bytes32 d = _digest(f);
        bytes memory approvalHere = _coNow(coSignerPk, d);
        vm.chainId(block.chainid + 7);
        vm.prank(session);
        vm.expectRevert(SigningLib.BadCoSignerSignature.selector);
        acct.authorizeSigningIntent(DESCRIPTOR_ID, f, new SigningLib.TokenCap[](0), _sign(sessionPk, d), approvalHere);
    }

    // ============ SR-3: epoch-bump re-arm needs a FRESH approval ============
    function test_SR3_staleApprovalRejectedAfterEpochBump() public {
        _setCoSigner(coSigner);
        uint256 amt = 0.5 ether;
        uint256 dl = block.timestamp + 1 hours;
        bytes memory firstApproval = _coApproval(coSignerPk, _digest(_fields(spender, amt, dl)), block.chainid, address(acct), acct.signingEpoch());
        bytes32 d = _armRaw(amt, dl, firstApproval);
        assertEq(acct.isValidSignature(d, ""), ERC1271_MAGIC);
        bytes memory staleApproval = _coApproval(coSignerPk, d, block.chainid, address(acct), acct.signingEpoch());

        // Owner tighten bumps the signing epoch, invalidating the arm (and the approval's epoch binding).
        vm.prank(owner);
        acct.tightenSigningGrant(DESCRIPTOR_ID, 1 ether, 1 days); // no-op values but bumps epoch
        assertEq(acct.isValidSignature(d, ""), ERC1271_INVALID);

        // Re-arm with the STALE (old-epoch) approval must fail...
        bytes32[] memory f = _fields(spender, amt, dl);
        vm.prank(session);
        vm.expectRevert(SigningLib.BadCoSignerSignature.selector);
        acct.authorizeSigningIntent(DESCRIPTOR_ID, f, new SigningLib.TokenCap[](0), _sign(sessionPk, d), staleApproval);
        // ...and succeed only with a FRESH (current-epoch) approval.
        bytes memory fresh = _coNow(coSignerPk, d);
        vm.prank(session);
        acct.authorizeSigningIntent(DESCRIPTOR_ID, f, new SigningLib.TokenCap[](0), _sign(sessionPk, d), fresh);
        assertEq(acct.isValidSignature(d, ""), ERC1271_MAGIC);
    }

    // ============ SR-6/SR-7: weaken is timelocked; authority is owner-only ============
    function test_SR6_removeIsTimelocked() public {
        _setCoSigner(coSigner);
        uint64 eBefore = acct.signingEpoch();
        vm.prank(owner);
        acct.setCoSigner(address(0)); // REMOVE → proposal only
        assertEq(acct.coSigner(), coSigner, "removal not instant");
        uint64 eta = acct.pendingCoSignerEta();
        assertGt(eta, 0);
        // apply before eta reverts
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV5.TimelockNotElapsed.selector, eta));
        acct.applyCoSigner();
        // after eta: removed + epoch bumped
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applyCoSigner();
        assertEq(acct.coSigner(), address(0));
        assertEq(acct.signingEpoch(), eBefore + 1, "apply bumps epoch");
    }

    function test_SR6_swapIsTimelocked() public {
        _setCoSigner(coSigner);
        (address co2,) = makeAddrAndKey("coSigner2");
        vm.prank(owner);
        acct.setCoSigner(co2); // SWAP → proposal only
        assertEq(acct.coSigner(), coSigner, "swap not instant");
        assertEq(acct.pendingCoSigner(), co2);
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applyCoSigner();
        assertEq(acct.coSigner(), co2);
    }

    function test_SR6_revokeCancelsPendingWeakening() public {
        _setCoSigner(coSigner);
        vm.prank(owner);
        acct.setCoSigner(address(0)); // pending removal
        assertGt(acct.pendingCoSignerEta(), 0);
        // `revoke` clears EVERY pending slot (`_clearPendingTimelocks`), cancelling the pending removal —
        // fail-safe: a revoked account must not later auto-drop its co-signer when the timelock elapses.
        vm.prank(guardian);
        acct.revoke();
        assertEq(acct.pendingCoSignerEta(), 0, "pending weakening cancelled by revoke");
        assertEq(acct.coSigner(), coSigner, "co-signer unchanged by revoke");
    }

    function test_SR7_onlyOwnerCanSetCoSigner() public {
        vm.prank(guardian);
        vm.expectRevert(LeashAccountV5.NotOwner.selector);
        acct.setCoSigner(coSigner);
        vm.prank(session);
        vm.expectRevert(LeashAccountV5.NotOwner.selector);
        acct.setCoSigner(coSigner);
    }

    function test_SR7_guardianCannotApply() public {
        _setCoSigner(coSigner);
        vm.prank(owner);
        acct.setCoSigner(address(0));
        vm.warp(block.timestamp + DELAY);
        vm.prank(guardian);
        vm.expectRevert(LeashAccountV5.NotOwner.selector);
        acct.applyCoSigner();
    }

    // ============ SR-8: malformed co-signer signature rejected ============
    function test_SR8_malformedSigRejected() public {
        _setCoSigner(coSigner);
        bytes32[] memory f = _fields(spender, 0.5 ether, block.timestamp + 1 hours);
        bytes32 d = _digest(f);
        // 64 zero bytes (wrong length / unrecoverable) → OZ tryRecover errors → BadCoSignerSignature.
        vm.prank(session);
        vm.expectRevert(SigningLib.BadCoSignerSignature.selector);
        acct.authorizeSigningIntent(DESCRIPTOR_ID, f, new SigningLib.TokenCap[](0), _sign(sessionPk, d), new bytes(64));
    }

    function test_applyCoSigner_nothingPendingReverts() public {
        vm.prank(owner);
        vm.expectRevert(LeashAccountV5.NothingPending.selector);
        acct.applyCoSigner();
    }

    // ============ Gate-② FP4-P2: setCoSigner(SAME value) is a true no-op ============
    // Re-asserting the current co-signer must NOT stage a spurious pending (which, if applied, would bump
    // the epoch + emit a misleading CoSignerChanged(X,X)); and it must CANCEL any in-flight weakening.
    function test_sameValue_isNoOp_doesNotStagePending() public {
        _setCoSigner(coSigner);
        uint64 e0 = acct.signingEpoch();
        _setCoSigner(coSigner); // re-assert the SAME co-signer
        assertEq(acct.coSigner(), coSigner, "co-signer unchanged");
        assertEq(acct.pendingCoSignerEta(), 0, "no spurious pending staged");
        assertEq(acct.signingEpoch(), e0, "no epoch bump on no-op");
        // and applying must revert — there is genuinely nothing pending.
        vm.prank(owner);
        vm.expectRevert(LeashAccountV5.NothingPending.selector);
        acct.applyCoSigner();
    }

    function test_sameValue_cancelsPendingWeakening() public {
        _setCoSigner(coSigner);
        vm.prank(owner);
        acct.setCoSigner(address(0)); // stage a pending REMOVAL
        assertGt(acct.pendingCoSignerEta(), 0, "removal staged");
        _setCoSigner(coSigner); // re-assert SAME → cancels the pending removal
        assertEq(acct.pendingCoSignerEta(), 0, "pending weakening cancelled by same-value re-assert");
        assertEq(acct.coSigner(), coSigner, "co-signer still active");
    }
}
