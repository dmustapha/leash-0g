// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {LeashAccountV5} from "../src/LeashAccountV5.sol";
import {DecodeLib} from "../src/DecodeLib.sol";
import {MockERC20} from "../src/MockERC20.sol";
import {SigningLib} from "../src/SigningLib.sol";

/// Stage F′ FP-3 (C-02 reopened) — the ONE-LEVEL-NESTED governed-signing decode (Permit2).
///
/// The money-spine claim this proves: a Permit2 `PermitSingle` has its governed `amount` INSIDE a
/// nested `PermitDetails` struct. The wall admits it safely by having the session key submit ALL
/// leaf words flat (nested leaves included) so `amount = leaves[amountLeafIndex]` is readable +
/// cappable, while the stored fold spec (`nestedTypeHash`/`nestedLeafStart`/`nestedLeafCount`)
/// lets the wall re-fold the sub-struct to reconstruct the REAL Permit2 digest. The test computes
/// that digest an INDEPENDENT (canonical EIP-712) way and asserts equality (R-4 / I-1), then proves
/// the cap binds the nested amount (R-1/I-2), the secondary `expiration` is window-bounded (R-2),
/// and the fold spec is validated at grant time in-contract (R-3).
contract LeashAccountV5SigningNestedTest is Test {
    LeashAccountV5 internal acct;
    MockERC20 internal usd;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal session;
    uint256 internal sessionPk;
    address internal permit2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3; // canonical Permit2
    address internal spender = makeAddr("uniswapRouter");

    uint32 constant WINDOW_SECONDS = 1 hours;
    uint64 constant DELAY = 15 minutes;
    bytes4 constant ERC1271_MAGIC = 0x1626ba7e;

    // Permit2 AllowanceTransfer PermitSingle — the real type strings (verified vs Uniswap source).
    bytes32 constant TH_DETAILS = keccak256("PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)");
    bytes32 constant TH_SINGLE = keccak256(
        "PermitSingle(PermitDetails details,address spender,uint256 sigDeadline)PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)"
    );

    // Flat leaf layout (tree pre-order): [token, amount, expiration, nonce, spender, sigDeadline].
    uint256 constant DID = 42;
    uint8 constant NUM_TOP = 3; // details(nested), spender, sigDeadline
    uint8 constant NESTED_START = 0; // details is top member 0
    uint8 constant NESTED_COUNT = 4; // token, amount, expiration, nonce
    uint8 constant SPENDER_LEAF = 4;
    uint8 constant AMOUNT_LEAF = 1;
    uint8 constant DEADLINE_LEAF = 5; // sigDeadline
    uint8 constant EXPIRY_LEAF = 2; // Permit2 expiration — the secondary window bound (R-2)

    uint128 constant CAP = 100 ether;
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
        usd = new MockERC20("Test USD 18", "TUSD18", 18);
        address[] memory list = new address[](0);
        acct = new LeashAccountV5(
            owner, guardian, session, _policy(), list, DELAY, address(usd), LeashAccountV5.TokenPolicy(0, 0), address(new SigningLib()), address(new DecodeLib())
        );
        usd.mint(address(acct), 1_000 ether);
        // Permit2 domain: name="Permit2", NO version, chainId, verifyingContract=Permit2.
        domainSep = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)"),
                keccak256("Permit2"),
                block.chainid,
                permit2
            )
        );
        _budget(address(usd), 500 ether);
    }

    // ---------- helpers ----------

    function _spenders(address a) internal pure returns (address[] memory s) {
        s = new address[](1);
        s[0] = a;
    }

    function _budget(address token, uint128 cap) internal {
        vm.prank(owner);
        acct.proposeSpendBudget(token, cap);
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applySpendBudget();
    }

    function _params() internal view returns (SigningLib.SigningGrantParams memory) {
        return SigningLib.SigningGrantParams({
            descriptorId: DID,
            domainSeparator: domainSep,
            typeHash: TH_SINGLE,
            numTopFields: NUM_TOP,
            spenderLeafIndex: SPENDER_LEAF,
            amountLeafIndex: AMOUNT_LEAF,
            deadlineLeafIndex: DEADLINE_LEAF,
            expiryLeafIndex: EXPIRY_LEAF,
            nestedTypeHash: TH_DETAILS,
            nestedLeafStart: NESTED_START,
            nestedLeafCount: NESTED_COUNT,
            token: address(usd),
            perIntentCap: CAP,
            maxDeadlineWindow: 1 hours,
            kind: 0,
            buyToken: address(0)
        });
    }

    function _grant() internal {
        vm.prank(owner);
        acct.proposeSigningGrantNested(_params(), _spenders(spender));
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applySigningGrant();
    }

    function _leaves(uint256 amount, uint256 expiration, uint256 sigDeadline)
        internal
        view
        returns (bytes32[] memory f)
    {
        f = new bytes32[](6); // totalLeaves = numTop(3) + nestedCount(4) - 1
        f[0] = bytes32(uint256(uint160(address(usd)))); // token
        f[1] = bytes32(amount); // amount (uint160, in a 32-byte word)
        f[2] = bytes32(expiration); // expiration (uint48)
        f[3] = bytes32(uint256(99)); // nonce
        f[4] = bytes32(uint256(uint160(spender))); // spender
        f[5] = bytes32(sigDeadline); // sigDeadline
    }

    /// INDEPENDENT canonical EIP-712 digest for Permit2 PermitSingle — the oracle a real
    /// protocol / viem computes. Deliberately NOT the contract's leaf-fold path.
    function _canonicalDigest(uint256 amount, uint256 expiration, uint256 sigDeadline)
        internal
        view
        returns (bytes32)
    {
        bytes32 detailsHash =
            keccak256(abi.encode(TH_DETAILS, address(usd), amount, expiration, uint256(99)));
        bytes32 singleHash = keccak256(abi.encode(TH_SINGLE, detailsHash, spender, sigDeadline));
        return keccak256(abi.encodePacked(hex"1901", domainSep, singleHash));
    }

    function _sign(bytes32 digest) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sessionPk, digest);
        return abi.encodePacked(r, s, v);
    }

    // ---------- R-4 / I-1: the wall's nested reconstruction == the canonical Permit2 digest ----------

    function test_nested_reconstructedDigest_equalsCanonical() public {
        _grant();
        uint256 amount = 10 ether;
        uint256 exp = block.timestamp + 30 minutes;
        uint256 sig = block.timestamp + 20 minutes;
        bytes32 expected = _canonicalDigest(amount, exp, sig);
        bytes32[] memory f = _leaves(amount, exp, sig);
        vm.prank(session);
        bytes32 armed = acct.authorizeSigningIntent(DID, f, _sign(expected), "");
        // the function returns the digest it reconstructed + armed; it MUST equal the oracle.
        assertEq(armed, expected, "nested reconstruction != canonical Permit2 digest");
        assertEq(acct.isValidSignature(expected, ""), ERC1271_MAGIC, "armed digest not valid");
    }

    // a wrong session signature over a DIFFERENT digest cannot arm (sig binds the reconstructed digest).
    function test_nested_sigOverWrongDigest_reverts() public {
        _grant();
        uint256 amount = 10 ether;
        uint256 exp = block.timestamp + 30 minutes;
        uint256 sig = block.timestamp + 20 minutes;
        bytes32[] memory f = _leaves(amount, exp, sig);
        bytes memory wrong = _sign(_canonicalDigest(amount + 1, exp, sig)); // signs a different amount
        vm.prank(session);
        vm.expectRevert(LeashAccountV5.BadIntentSignature.selector);
        acct.authorizeSigningIntent(DID, f, wrong, "");
    }

    // ---------- R-1 / I-2: the per-intent cap binds the NESTED amount leaf ----------

    function test_nested_overCapNestedAmount_reverts() public {
        _grant();
        uint256 amount = CAP + 1; // just over the cap, read from the NESTED amount leaf
        uint256 exp = block.timestamp + 30 minutes;
        uint256 sig = block.timestamp + 20 minutes;
        bytes32[] memory f = _leaves(amount, exp, sig);
        bytes memory s = _sign(_canonicalDigest(amount, exp, sig));
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV5.OverPerIntentCap.selector, amount, CAP));
        acct.authorizeSigningIntent(DID, f, s, "");
    }

    function test_nested_debitsSharedBudgetFromNestedAmount() public {
        _grant();
        uint256 amount = 40 ether;
        uint256 exp = block.timestamp + 30 minutes;
        uint256 sig = block.timestamp + 20 minutes;
        bytes32[] memory f = _leaves(amount, exp, sig);
        vm.prank(session);
        acct.authorizeSigningIntent(DID, f, _sign(_canonicalDigest(amount, exp, sig)), "");
        (,, uint128 spent,) = acct.spendBudget(address(usd));
        assertEq(spent, uint128(amount), "nested amount not debited to the shared budget");
    }

    // ---------- R-2: the secondary expiry (Permit2 expiration) is window-bounded ----------

    function test_nested_expirationBeyondWindow_reverts() public {
        _grant();
        uint256 amount = 10 ether;
        uint256 exp = block.timestamp + 2 hours; // > maxDeadlineWindow (1 hour)
        uint256 sig = block.timestamp + 20 minutes; // sigDeadline fine
        bytes32[] memory f = _leaves(amount, exp, sig);
        bytes memory s = _sign(_canonicalDigest(amount, exp, sig));
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV5.DeadlineTooFar.selector, exp));
        acct.authorizeSigningIntent(DID, f, s, "");
    }

    // ---------- R-3: fold-spec validation at grant time (in-contract) ----------

    function test_grant_nestedCountZeroWithTypeHash_reverts() public {
        SigningLib.SigningGrantParams memory p = _params();
        p.nestedLeafCount = 0; // nestedTypeHash set but count 0 ⇒ invalid
        vm.prank(owner);
        vm.expectRevert(LeashAccountV5.InvalidPolicy.selector);
        acct.proposeSigningGrantNested(p, _spenders(spender));
    }

    function test_grant_roleLeafOutOfRange_reverts() public {
        SigningLib.SigningGrantParams memory p = _params();
        p.amountLeafIndex = 9; // totalLeaves == 5 ⇒ out of range
        vm.prank(owner);
        vm.expectRevert(LeashAccountV5.InvalidPolicy.selector);
        acct.proposeSigningGrantNested(p, _spenders(spender));
    }

    function test_grant_expiryAliasesAmount_reverts() public {
        SigningLib.SigningGrantParams memory p = _params();
        p.expiryLeafIndex = AMOUNT_LEAF; // expiry aliases the amount leaf
        vm.prank(owner);
        vm.expectRevert(LeashAccountV5.InvalidPolicy.selector);
        acct.proposeSigningGrantNested(p, _spenders(spender));
    }

    function test_grant_nestedStartBeyondTop_reverts() public {
        SigningLib.SigningGrantParams memory p = _params();
        p.nestedLeafStart = NUM_TOP; // nested member position must be < numTopFields
        vm.prank(owner);
        vm.expectRevert(LeashAccountV5.InvalidPolicy.selector);
        acct.proposeSigningGrantNested(p, _spenders(spender));
    }

    // ---------- fail-closed: a mis-shaped leaf array at arm time ----------

    function test_nested_wrongLeafCount_reverts() public {
        _grant();
        bytes32[] memory f = new bytes32[](4); // totalLeaves must be 5
        vm.prank(session);
        vm.expectRevert(LeashAccountV5.DecodeMismatch.selector);
        acct.authorizeSigningIntent(DID, f, _sign(bytes32(uint256(1))), "");
    }

    // ---------- Gate-② R-4: a wrong stored nestedTypeHash folds to a non-canonical digest ----------

    function test_nested_wrongNestedTypeHash_sigFails() public {
        LeashAccountV5SigningNestedParams_wrong();
        uint256 amount = 10 ether;
        uint256 exp = block.timestamp + 30 minutes;
        uint256 sig = block.timestamp + 20 minutes;
        bytes32[] memory f = _leaves(amount, exp, sig);
        bytes memory s = _sign(_canonicalDigest(amount, exp, sig)); // signs the REAL Permit2 digest
        vm.prank(session);
        vm.expectRevert(LeashAccountV5.BadIntentSignature.selector); // wrong fold ⇒ sig can't recover
        acct.authorizeSigningIntent(DID, f, s, "");
    }

    function LeashAccountV5SigningNestedParams_wrong() internal {
        SigningLib.SigningGrantParams memory p = _params();
        p.nestedTypeHash = TH_SINGLE; // deliberately wrong (should be TH_DETAILS)
        vm.prank(owner);
        acct.proposeSigningGrantNested(p, _spenders(spender));
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applySigningGrant();
    }

    // ---------- Gate-② M-01: rotating the session key invalidates in-flight armed intents ----------

    function test_nested_sessionKeyRotation_invalidatesArm() public {
        _grant();
        uint256 amount = 10 ether;
        uint256 exp = block.timestamp + 30 minutes;
        uint256 sig = block.timestamp + 20 minutes;
        bytes32 expected = _canonicalDigest(amount, exp, sig);
        bytes32[] memory f = _leaves(amount, exp, sig);
        vm.prank(session);
        acct.authorizeSigningIntent(DID, f, _sign(expected), "");
        assertEq(acct.isValidSignature(expected, ""), ERC1271_MAGIC, "armed before rotation");

        vm.prank(owner);
        acct.setSessionKey(makeAddr("newSession"));
        assertEq(acct.isValidSignature(expected, ""), bytes4(0xffffffff), "arm invalid after rotation");
    }

    // ---------- Gate-② L-01: a zero/past expiry leaf is rejected (no budget drain) ----------

    function test_nested_pastExpiry_reverts() public {
        _grant();
        uint256 amount = 10 ether;
        uint256 pastExp = block.timestamp; // == now ⇒ already void downstream (must revert, not debit)
        uint256 sig = block.timestamp + 20 minutes;
        bytes32[] memory f = _leaves(amount, pastExp, sig);
        bytes memory s = _sign(_canonicalDigest(amount, pastExp, sig));
        vm.prank(session);
        vm.expectRevert(LeashAccountV5.DeadlineInPast.selector);
        acct.authorizeSigningIntent(DID, f, s, "");
    }

    // ---------- PermitTransferFrom shape (the other one-level Permit2 struct) ----------

    function test_nested_permitTransferFrom_reconstructs() public {
        // PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)
        // TokenPermissions(address token,uint256 amount) — nested member 0, 2 leaves.
        bytes32 thTok = keccak256("TokenPermissions(address token,uint256 amount)");
        bytes32 thPtf = keccak256(
            "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
        );
        uint256 did2 = 43;
        SigningLib.SigningGrantParams memory p = SigningLib.SigningGrantParams({
            descriptorId: did2,
            domainSeparator: domainSep,
            typeHash: thPtf,
            numTopFields: 4, // permitted(nested), spender, nonce, deadline
            spenderLeafIndex: 2, // leaves: [token, amount, spender, nonce, deadline]
            amountLeafIndex: 1,
            deadlineLeafIndex: 4,
            expiryLeafIndex: type(uint8).max, // no secondary expiry
            nestedTypeHash: thTok,
            nestedLeafStart: 0,
            nestedLeafCount: 2,
            token: address(usd),
            perIntentCap: CAP,
            maxDeadlineWindow: 1 hours,
            kind: 0,
            buyToken: address(0)
        });
        vm.prank(owner);
        acct.proposeSigningGrantNested(p, _spenders(spender));
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applySigningGrant();

        uint256 amount = 5 ether;
        uint256 deadline = block.timestamp + 20 minutes;
        bytes32[] memory f = new bytes32[](5);
        f[0] = bytes32(uint256(uint160(address(usd))));
        f[1] = bytes32(amount);
        f[2] = bytes32(uint256(uint160(spender)));
        f[3] = bytes32(uint256(123)); // nonce
        f[4] = bytes32(deadline);
        // canonical oracle
        bytes32 tokHash = keccak256(abi.encode(thTok, address(usd), amount));
        bytes32 ptfHash = keccak256(abi.encode(thPtf, tokHash, spender, uint256(123), deadline));
        bytes32 expected = keccak256(abi.encodePacked(hex"1901", domainSep, ptfHash));
        vm.prank(session);
        bytes32 armed = acct.authorizeSigningIntent(did2, f, _sign(expected), "");
        assertEq(armed, expected, "PermitTransferFrom reconstruction != canonical");
        assertEq(acct.isValidSignature(expected, ""), ERC1271_MAGIC);
    }
}
