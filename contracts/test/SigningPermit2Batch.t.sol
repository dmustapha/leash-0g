// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {LeashAccountV5} from "../src/LeashAccountV5.sol";
import {DecodeLib} from "../src/DecodeLib.sol";
import {SigningLib} from "../src/SigningLib.sol";
import {MockERC20} from "../src/MockERC20.sol";

/// Stage F′ FP-4 Slice-5 — Permit2 `PermitBatchTransferFrom` (SignatureTransfer) governed-signing family (the
/// first `kind: batch`): an ARRAY-of-`TokenPermissions` fold, a reviewed per-token cap allowlist committed as
/// a hash (caps-hash commit, Dami 2026-10-08), per-token Σ bounds, and a per-token LOOP-debit on the account.
///
/// A bound agent may sign a fully-pinned MULTI-TOKEN batch transfer permit; `authorizeSigningIntent` arms it
/// and `isValidSignature` returns the ERC-1271 magic while live — but the wall hard-bounds the outflow PER
/// TOKEN (`Σ amountᵢ(token) ≤ perTokenCap(token)` on the SAME per-token budget the calling path debits),
/// rejects any token outside the reviewed allowlist, rejects zero-amount padding + non-canonical words,
/// allowlists the spender, verifies the submitted caps against the committed hash, and refuses any batch that
/// is not the reviewed shape. Token-KEYED accumulation (the R-1 Gate-② fix) is proven by the interleave test.
contract SigningPermit2BatchTest is Test {
    LeashAccountV5 internal acct;
    MockERC20 internal tokA; // reviewed token A (18dp)
    MockERC20 internal tokB; // reviewed token B (18dp)
    MockERC20 internal tokC; // NOT in the allowlist

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal session;
    uint256 internal sessionPk;
    address internal spender = makeAddr("spender");
    address internal attacker = makeAddr("attacker");

    uint32 constant WINDOW_SECONDS = 1 hours;
    uint64 constant DELAY = 15 minutes;
    bytes4 constant ERC1271_MAGIC = 0x1626ba7e;
    bytes4 constant ERC1271_INVALID = 0xffffffff;

    uint256 constant DID = 40; // Permit2 batch descriptor-id namespace
    uint8 constant KIND_BATCH = 2;
    uint8 constant FF = type(uint8).max;

    // The canonical Permit2 type strings — recomputed here independently (genuine non-circular oracle, §7).
    string constant TOKEN_PERMISSIONS_TYPE = "TokenPermissions(address token,uint256 amount)";
    string constant PBTF_TYPE =
        "PermitBatchTransferFrom(TokenPermissions[] permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)";
    bytes32 constant TOKEN_PERMISSIONS_TYPEHASH = keccak256(bytes(TOKEN_PERMISSIONS_TYPE));
    bytes32 constant PBTF_TYPEHASH = keccak256(bytes(PBTF_TYPE));
    // Permit2's published constants (asserted == the recomputed values — a wrong constant is a LOUD failure).
    bytes32 constant PBTF_TYPEHASH_PUBLISHED = 0xfcf35f5ac6a2c28868dc44c302166470266239195f02b0ee408334829333b766;
    bytes32 constant TOKEN_PERMISSIONS_TYPEHASH_PUBLISHED =
        0x618358ac3db8dc274f0cd8829da7e234bd48cd73c4a740aede1adec9846d06a1;

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
        tokA = new MockERC20("Token A", "A", 18);
        tokB = new MockERC20("Token B", "B", 18);
        tokC = new MockERC20("Token C", "C", 18);
        address[] memory list = new address[](0);
        acct = new LeashAccountV5(
            owner, guardian, session, _policy(), list, DELAY, address(tokA),
            LeashAccountV5.TokenPolicy(0, 0), address(new SigningLib()), address(new DecodeLib())
        );
        // Permit2 domain (name "Permit2", NO version), chainId-bound (N-01).
        domainSep = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)"),
                keccak256("Permit2"),
                block.chainid,
                0x000000000022D473030F116dDEE9F6B43aC78BA3
            )
        );
    }

    // ---------- helpers ----------

    function _budget(address token, uint128 cap) internal {
        vm.prank(owner);
        acct.proposeSpendBudget(token, cap);
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applySpendBudget();
    }

    /// The reviewed caps allowlist: tokA → capA, tokB → capB.
    function _caps(uint128 capA, uint128 capB) internal view returns (SigningLib.TokenCap[] memory caps) {
        caps = new SigningLib.TokenCap[](2);
        caps[0] = SigningLib.TokenCap(address(tokA), capA);
        caps[1] = SigningLib.TokenCap(address(tokB), capB);
    }

    function _grantBatch(SigningLib.TokenCap[] memory caps) internal {
        address[] memory sp = new address[](1);
        sp[0] = spender;
        vm.prank(owner);
        acct.proposeSigningGrantNested(
            SigningLib.SigningGrantParams(
                DID, domainSep, PBTF_TYPEHASH, 4, // numTopFields = 4
                FF, FF, FF, FF, // all four scalar indices = 0xFF (unused — wall derives from N)
                TOKEN_PERMISSIONS_TYPEHASH, 0, 2, // nestedTypeHash, nestedLeafStart=0, nestedLeafCount=2
                address(tokA), 0, WINDOW_SECONDS, // token (placeholder nonzero), perIntentCap unused, window
                KIND_BATCH, address(0) // kind=batch, buyToken=0
            ),
            sp,
            caps
        );
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applySigningGrant();
    }

    /// Build the 2N+3 leaf words: [token0,amount0, …, spender, nonce, deadline].
    function _fields(address[] memory tokens, uint256[] memory amounts, address sp, uint256 nonce, uint256 deadline)
        internal
        pure
        returns (bytes32[] memory f)
    {
        uint256 n = tokens.length;
        f = new bytes32[](2 * n + 3);
        for (uint256 i = 0; i < n; i++) {
            f[2 * i] = bytes32(uint256(uint160(tokens[i])));
            f[2 * i + 1] = bytes32(amounts[i]);
        }
        f[2 * n] = bytes32(uint256(uint160(sp)));
        f[2 * n + 1] = bytes32(nonce);
        f[2 * n + 2] = bytes32(deadline);
    }

    /// Reconstruct the real PermitBatchTransferFrom digest (array-fold), independent of SigningLib.
    function _digest(bytes32[] memory f) internal view returns (bytes32) {
        uint256 n = (f.length - 3) / 2;
        bytes memory arrayBuf;
        for (uint256 i = 0; i < n; i++) {
            arrayBuf = abi.encodePacked(arrayBuf, keccak256(abi.encodePacked(TOKEN_PERMISSIONS_TYPEHASH, f[2 * i], f[2 * i + 1])));
        }
        bytes32 arrayHash = keccak256(arrayBuf);
        bytes32 structHash = keccak256(abi.encodePacked(PBTF_TYPEHASH, arrayHash, f[2 * n], f[2 * n + 1], f[2 * n + 2]));
        return keccak256(abi.encodePacked(hex"1901", domainSep, structHash));
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _arm(bytes32[] memory f, SigningLib.TokenCap[] memory caps) internal returns (bytes32 digest) {
        digest = _digest(f);
        vm.prank(session);
        acct.authorizeSigningIntent(DID, f, caps, _sign(sessionPk, digest), "");
    }

    function _submitExpectRevert(bytes32[] memory f, SigningLib.TokenCap[] memory caps, bytes memory expected) internal {
        vm.prank(session);
        vm.expectRevert(expected);
        acct.authorizeSigningIntent(DID, f, caps, _sign(sessionPk, _digest(f)), "");
    }

    function _spent(address token) internal view returns (uint128 spent) {
        (,, spent,) = acct.spendBudget(token);
    }

    /// A simple 2-token batch [tokA:aAmt, tokB:bAmt] with the reviewed spender + the given deadline.
    function _twoToken(uint256 aAmt, uint256 bAmt, uint256 deadline) internal view returns (bytes32[] memory) {
        address[] memory t = new address[](2);
        t[0] = address(tokA);
        t[1] = address(tokB);
        uint256[] memory a = new uint256[](2);
        a[0] = aAmt;
        a[1] = bAmt;
        return _fields(t, a, spender, 7, deadline);
    }

    // ============ constant / typeHash parity (§3a / §7) ============

    function test_typeHash_matchesPublished() public pure {
        assertEq(PBTF_TYPEHASH, PBTF_TYPEHASH_PUBLISHED, "PBTF_TYPEHASH must equal Permit2's published value");
        assertEq(TOKEN_PERMISSIONS_TYPEHASH, TOKEN_PERMISSIONS_TYPEHASH_PUBLISHED, "TokenPermissions typehash");
    }

    // ============ happy path (multi-token) ============

    function test_happy_multiToken_armsAndDebitsPerToken() public {
        _budget(address(tokA), 500 ether);
        _budget(address(tokB), 500 ether);
        _grantBatch(_caps(100 ether, 100 ether));
        bytes32 digest = _arm(_twoToken(60 ether, 40 ether, block.timestamp + 30 minutes), _caps(100 ether, 100 ether));
        assertEq(acct.isValidSignature(digest, ""), ERC1271_MAGIC, "fully-pinned batch is valid while live");
        assertEq(_spent(address(tokA)), 60 ether, "tokA budget debited by its Sigma");
        assertEq(_spent(address(tokB)), 40 ether, "tokB budget debited by its Sigma");
    }

    function test_happy_digestEqualsReconstruction() public {
        _budget(address(tokA), 500 ether);
        _budget(address(tokB), 500 ether);
        _grantBatch(_caps(100 ether, 100 ether));
        bytes32[] memory f = _twoToken(10 ether, 20 ether, block.timestamp + 20 minutes);
        bytes32 armed = _arm(f, _caps(100 ether, 100 ether));
        assertEq(armed, _digest(f), "wall digest == recomputed real PermitBatchTransferFrom digest");
    }

    function test_happy_cumulativeAcrossTwoArms() public {
        _budget(address(tokA), 500 ether);
        _budget(address(tokB), 500 ether);
        _grantBatch(_caps(100 ether, 100 ether));
        _arm(_twoToken(60 ether, 40 ether, block.timestamp + 30 minutes), _caps(100 ether, 100 ether));
        // second arm (different nonce via a different amount ⇒ different digest) accumulates in the budget.
        address[] memory t = new address[](1);
        t[0] = address(tokA);
        uint256[] memory a = new uint256[](1);
        a[0] = 30 ether;
        _arm(_fields(t, a, spender, 8, block.timestamp + 30 minutes), _caps(100 ether, 100 ether));
        assertEq(_spent(address(tokA)), 90 ether, "tokA cumulative across two armed batches");
    }

    // ============ token-keyed accumulator (R-1 Gate-2 fix) — the interleave test ============

    function test_interleave_tokenKeyedAccumulator_overCap() public {
        _budget(address(tokA), 500 ether);
        _budget(address(tokB), 500 ether);
        _grantBatch(_caps(100 ether, 100 ether));
        // [A:100 (==cap), B:1, A:1] — A's TWO elements straddle a B element; a token-keyed sum = 101 > capA.
        // A naive in-order running sum (reset by the B element) would WRONGLY pass. Must revert OverPerIntentCap.
        address[] memory t = new address[](3);
        t[0] = address(tokA);
        t[1] = address(tokB);
        t[2] = address(tokA);
        uint256[] memory a = new uint256[](3);
        a[0] = 100 ether;
        a[1] = 1 ether;
        a[2] = 1 ether;
        bytes32[] memory f = _fields(t, a, spender, 7, block.timestamp + 10 minutes);
        _submitExpectRevert(f, _caps(100 ether, 100 ether), abi.encodeWithSelector(SigningLib.OverPerIntentCap.selector, uint256(101 ether), uint128(100 ether)));
    }

    function test_perTokenSumOverCap_reverts() public {
        _budget(address(tokA), 500 ether);
        _budget(address(tokB), 500 ether);
        _grantBatch(_caps(100 ether, 100 ether));
        // two tokA elements 60 + 50 = 110 > capA 100.
        address[] memory t = new address[](2);
        t[0] = address(tokA);
        t[1] = address(tokA);
        uint256[] memory a = new uint256[](2);
        a[0] = 60 ether;
        a[1] = 50 ether;
        bytes32[] memory f = _fields(t, a, spender, 7, block.timestamp + 10 minutes);
        _submitExpectRevert(f, _caps(100 ether, 100 ether), abi.encodeWithSelector(SigningLib.OverPerIntentCap.selector, uint256(110 ether), uint128(100 ether)));
    }

    function test_singleElementOverCap_failFast_reverts() public {
        _budget(address(tokA), 500 ether);
        _budget(address(tokB), 500 ether);
        _grantBatch(_caps(100 ether, 100 ether));
        bytes32[] memory f = _twoToken(101 ether, 1 ether, block.timestamp + 10 minutes);
        _submitExpectRevert(f, _caps(100 ether, 100 ether), abi.encodeWithSelector(SigningLib.OverPerIntentCap.selector, uint256(101 ether), uint128(100 ether)));
    }

    // ============ element hygiene (R-1) ============

    function test_zeroAmountElement_reverts() public {
        _budget(address(tokA), 500 ether);
        _budget(address(tokB), 500 ether);
        _grantBatch(_caps(100 ether, 100 ether));
        bytes32[] memory f = _twoToken(10 ether, 0, block.timestamp + 10 minutes);
        _submitExpectRevert(f, _caps(100 ether, 100 ether), abi.encodeWithSelector(SigningLib.DecodeMismatch.selector));
    }

    function test_tokenNotInAllowlist_reverts() public {
        _budget(address(tokA), 500 ether);
        _budget(address(tokB), 500 ether);
        _grantBatch(_caps(100 ether, 100 ether));
        address[] memory t = new address[](1);
        t[0] = address(tokC); // not reviewed
        uint256[] memory a = new uint256[](1);
        a[0] = 1 ether;
        bytes32[] memory f = _fields(t, a, spender, 7, block.timestamp + 10 minutes);
        _submitExpectRevert(f, _caps(100 ether, 100 ether), abi.encodeWithSelector(SigningLib.DecodeMismatch.selector));
    }

    function test_nonCanonicalToken_reverts() public {
        _budget(address(tokA), 500 ether);
        _budget(address(tokB), 500 ether);
        _grantBatch(_caps(100 ether, 100 ether));
        bytes32[] memory f = _twoToken(10 ether, 10 ether, block.timestamp + 10 minutes);
        f[0] = bytes32(uint256(0xdead) << 160 | uint256(uint160(address(tokA)))); // dirty upper bits
        _submitExpectRevert(f, _caps(100 ether, 100 ether), abi.encodeWithSelector(SigningLib.DecodeMismatch.selector));
    }

    function test_nonCanonicalSpender_reverts() public {
        _budget(address(tokA), 500 ether);
        _budget(address(tokB), 500 ether);
        _grantBatch(_caps(100 ether, 100 ether));
        bytes32[] memory f = _twoToken(10 ether, 10 ether, block.timestamp + 10 minutes);
        f[4] = bytes32(uint256(0x1) << 160 | uint256(uint160(spender))); // spender word (2N=4) non-canonical
        _submitExpectRevert(f, _caps(100 ether, 100 ether), abi.encodeWithSelector(SigningLib.DecodeMismatch.selector));
    }

    // ============ N bounds + shape ============

    function test_emptyBatch_N0_reverts() public {
        _budget(address(tokA), 500 ether);
        _budget(address(tokB), 500 ether);
        _grantBatch(_caps(100 ether, 100 ether));
        // N=0 ⇒ only [spender, nonce, deadline] = 3 words (< 5) ⇒ DecodeMismatch.
        address[] memory t = new address[](0);
        uint256[] memory a = new uint256[](0);
        bytes32[] memory f = _fields(t, a, spender, 7, block.timestamp + 10 minutes);
        _submitExpectRevert(f, _caps(100 ether, 100 ether), abi.encodeWithSelector(SigningLib.DecodeMismatch.selector));
    }

    function test_N15_over32Leaves_reverts() public {
        _budget(address(tokA), 500 ether);
        _budget(address(tokB), 500 ether);
        _grantBatch(_caps(100 ether, 100 ether));
        // N=15 ⇒ 2*15+3 = 33 > 32 ⇒ DecodeMismatch (the 32-leaf ceiling, R-1).
        address[] memory t = new address[](15);
        uint256[] memory a = new uint256[](15);
        for (uint256 i = 0; i < 15; i++) {
            t[i] = address(tokA);
            a[i] = 1;
        }
        bytes32[] memory f = _fields(t, a, spender, 7, block.timestamp + 10 minutes);
        _submitExpectRevert(f, _caps(100 ether, 100 ether), abi.encodeWithSelector(SigningLib.DecodeMismatch.selector));
    }

    function test_oddLeafCount_reverts() public {
        _budget(address(tokA), 500 ether);
        _budget(address(tokB), 500 ether);
        _grantBatch(_caps(100 ether, 100 ether));
        bytes32[] memory f = _twoToken(10 ether, 10 ether, block.timestamp + 10 minutes); // length 7 (valid)
        // drop one word ⇒ length 6 ⇒ (6-3)=3 odd ⇒ DecodeMismatch.
        bytes32[] memory bad = new bytes32[](6);
        for (uint256 i = 0; i < 6; i++) bad[i] = f[i];
        _submitExpectRevert(bad, _caps(100 ether, 100 ether), abi.encodeWithSelector(SigningLib.DecodeMismatch.selector));
    }

    // ============ overflow (C-2, fail-closed) ============

    function test_overflow_hugeAmount_failsClosed_noDebit() public {
        _budget(address(tokA), 500 ether);
        _budget(address(tokB), 500 ether);
        _grantBatch(_caps(100 ether, 100 ether));
        // An amount near 2^256 trips the per-element fail-fast (amount > cap) FIRST ⇒ OverPerIntentCap, no
        // debit (fail-closed). The token-keyed accumulator uses CHECKED adds, so even absent the fail-fast a
        // Σ overflow would Panic(0x11); that path is unreachable given uint128 caps + N≤14 (see RESULTS).
        bytes32[] memory f = _twoToken(type(uint256).max, 1 ether, block.timestamp + 10 minutes);
        _submitExpectRevert(f, _caps(100 ether, 100 ether), abi.encodeWithSelector(SigningLib.OverPerIntentCap.selector, type(uint256).max, uint128(100 ether)));
        assertEq(_spent(address(tokA)), 0, "fail-closed: no debit");
    }

    // ============ spender allowlist (I-1 kept — batch is NOT order) ============

    function test_spenderNotAllowlisted_reverts() public {
        _budget(address(tokA), 500 ether);
        _budget(address(tokB), 500 ether);
        _grantBatch(_caps(100 ether, 100 ether));
        bytes32[] memory f = _twoToken(10 ether, 10 ether, block.timestamp + 10 minutes);
        f[4] = bytes32(uint256(uint160(attacker))); // spender ∉ allowlist
        _submitExpectRevert(f, _caps(100 ether, 100 ether), abi.encodeWithSelector(LeashAccountV5.SpenderNotAllowlisted.selector, attacker));
    }

    // ============ deadline window ============

    function test_deadlineInPast_reverts() public {
        _budget(address(tokA), 500 ether);
        _budget(address(tokB), 500 ether);
        _grantBatch(_caps(100 ether, 100 ether));
        bytes32[] memory f = _twoToken(10 ether, 10 ether, block.timestamp - 1);
        _submitExpectRevert(f, _caps(100 ether, 100 ether), abi.encodeWithSelector(SigningLib.DeadlineInPast.selector));
    }

    function test_deadlineTooFar_reverts() public {
        _budget(address(tokA), 500 ether);
        _budget(address(tokB), 500 ether);
        _grantBatch(_caps(100 ether, 100 ether));
        uint256 tooFar = block.timestamp + 2 hours;
        bytes32[] memory f = _twoToken(10 ether, 10 ether, tooFar);
        _submitExpectRevert(f, _caps(100 ether, 100 ether), abi.encodeWithSelector(SigningLib.DeadlineTooFar.selector, tooFar));
    }

    // ============ caps-hash commit ============

    function test_capsHashMismatch_reverts() public {
        _budget(address(tokA), 500 ether);
        _budget(address(tokB), 500 ether);
        _grantBatch(_caps(100 ether, 100 ether));
        // submit a DIFFERENT caps set (capA tampered) than the one committed ⇒ keccak mismatch ⇒ DecodeMismatch.
        bytes32[] memory f = _twoToken(10 ether, 10 ether, block.timestamp + 10 minutes);
        _submitExpectRevert(f, _caps(999 ether, 100 ether), abi.encodeWithSelector(SigningLib.DecodeMismatch.selector));
    }

    // ============ grant-time validation (§4.2) ============

    function test_grant_dupTokenInCaps_revertsAtGrant() public {
        SigningLib.TokenCap[] memory caps = new SigningLib.TokenCap[](2);
        caps[0] = SigningLib.TokenCap(address(tokA), 100 ether);
        caps[1] = SigningLib.TokenCap(address(tokA), 50 ether); // duplicate token
        address[] memory sp = new address[](1);
        sp[0] = spender;
        vm.prank(owner);
        vm.expectRevert(SigningLib.InvalidPolicy.selector);
        acct.proposeSigningGrantNested(
            SigningLib.SigningGrantParams(
                DID, domainSep, PBTF_TYPEHASH, 4, FF, FF, FF, FF, TOKEN_PERMISSIONS_TYPEHASH, 0, 2,
                address(tokA), 0, WINDOW_SECONDS, KIND_BATCH, address(0)
            ),
            sp,
            caps
        );
    }

    function test_grant_emptyCaps_revertsAtGrant() public {
        SigningLib.TokenCap[] memory caps = new SigningLib.TokenCap[](0);
        address[] memory sp = new address[](1);
        sp[0] = spender;
        vm.prank(owner);
        vm.expectRevert(SigningLib.InvalidPolicy.selector);
        acct.proposeSigningGrantNested(
            SigningLib.SigningGrantParams(
                DID, domainSep, PBTF_TYPEHASH, 4, FF, FF, FF, FF, TOKEN_PERMISSIONS_TYPEHASH, 0, 2,
                address(tokA), 0, WINDOW_SECONDS, KIND_BATCH, address(0)
            ),
            sp,
            caps
        );
    }

    function test_grant_scalarIndexNot0xFF_revertsAtGrant() public {
        address[] memory sp = new address[](1);
        sp[0] = spender;
        vm.prank(owner);
        vm.expectRevert(SigningLib.InvalidPolicy.selector);
        acct.proposeSigningGrantNested(
            SigningLib.SigningGrantParams(
                DID, domainSep, PBTF_TYPEHASH, 4, 0, FF, FF, FF, // spenderIndex=0 (NOT 0xFF) for a batch
                TOKEN_PERMISSIONS_TYPEHASH, 0, 2, address(tokA), 0, WINDOW_SECONDS, KIND_BATCH, address(0)
            ),
            sp,
            _caps(100 ether, 100 ether)
        );
    }

    function test_grant_zeroCap_revertsAtGrant() public {
        SigningLib.TokenCap[] memory caps = new SigningLib.TokenCap[](1);
        caps[0] = SigningLib.TokenCap(address(tokA), 0); // zero cap
        address[] memory sp = new address[](1);
        sp[0] = spender;
        vm.prank(owner);
        vm.expectRevert(SigningLib.InvalidPolicy.selector);
        acct.proposeSigningGrantNested(
            SigningLib.SigningGrantParams(
                DID, domainSep, PBTF_TYPEHASH, 4, FF, FF, FF, FF, TOKEN_PERMISSIONS_TYPEHASH, 0, 2,
                address(tokA), 0, WINDOW_SECONDS, KIND_BATCH, address(0)
            ),
            sp,
            caps
        );
    }

    function test_grant_nonBatchWithCaps_revertsAtGrant() public {
        // A KIND_STANDARD grant carrying a non-empty caps array is mis-authored ⇒ InvalidPolicy.
        address[] memory sp = new address[](1);
        sp[0] = spender;
        vm.prank(owner);
        vm.expectRevert(SigningLib.InvalidPolicy.selector);
        acct.proposeSigningGrantNested(
            SigningLib.SigningGrantParams(
                41, domainSep, PBTF_TYPEHASH, 5, 1, 2, 3, FF, bytes32(0), 0, 0,
                address(tokA), 100 ether, WINDOW_SECONDS, 0, address(0) // kind=STANDARD
            ),
            sp,
            _caps(100 ether, 100 ether) // caps on a non-batch grant
        );
    }

    // ============ budget fail-closed (a batch token with no funded budget) ============

    function test_batchTokenWithoutBudget_reverts() public {
        _budget(address(tokA), 500 ether); // only tokA funded; tokB has no budget
        _grantBatch(_caps(100 ether, 100 ether));
        bytes32[] memory f = _twoToken(10 ether, 10 ether, block.timestamp + 10 minutes);
        _submitExpectRevert(f, _caps(100 ether, 100 ether), abi.encodeWithSelector(LeashAccountV5.BudgetNotSet.selector, address(tokB)));
    }

    // ============ fail-safe parity (revoke / tighten kill an armed batch) ============

    function test_parity_revokeFailsClosed() public {
        _budget(address(tokA), 500 ether);
        _budget(address(tokB), 500 ether);
        _grantBatch(_caps(100 ether, 100 ether));
        bytes32 digest = _arm(_twoToken(10 ether, 10 ether, block.timestamp + 10 minutes), _caps(100 ether, 100 ether));
        vm.prank(guardian);
        acct.revoke();
        assertEq(acct.isValidSignature(digest, ""), ERC1271_INVALID, "revoke fail-closes an armed batch");
    }
}
