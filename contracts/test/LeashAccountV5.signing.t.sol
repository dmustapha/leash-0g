// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {LeashAccountV5} from "../src/LeashAccountV5.sol";
import {DecodeLib} from "../src/DecodeLib.sol";
import {SigningLib} from "../src/SigningLib.sol";
import {MockERC20} from "../src/MockERC20.sol";

/// Stage F′ FP-1 — the ERC-1271 governed-signing spine.
///
/// Design (the load-bearing fact): ERC-1271 `isValidSignature` is `view` and is
/// `staticcall`ed by protocols, so it CANNOT debit a budget. "signing ≤ calling"
/// therefore forces a stateful PRE-AUTHORIZATION: the session key submits the
/// intent via `authorizeSigningIntent` (mutating) which validates the descriptor +
/// policy, debits the SAME per-token `executeCall` budget, and ARMS the EIP-712
/// digest. `isValidSignature` is then a pure armed-lookup (default-deny, fails-closed
/// on revoke / expiry). This mirrors the Stage-D one-shot (`authorizeOnce`) pattern.
contract LeashAccountV5SigningTest is Test {
    LeashAccountV5 internal acct;
    MockERC20 internal usd; // 18dp signing-budget token

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal session;
    uint256 internal sessionPk;
    address internal spender = makeAddr("cowSettler");
    address internal attacker = makeAddr("attacker");

    uint32 constant WINDOW_SECONDS = 1 hours;
    uint64 constant DELAY = 15 minutes;

    bytes4 constant ERC1271_MAGIC = 0x1626ba7e;
    bytes4 constant ERC1271_INVALID = 0xffffffff;

    // A flat ERC-2612-shape permit descriptor: 5 static words.
    //   Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)
    uint256 constant DESCRIPTOR_ID = 1;
    bytes32 constant TYPEHASH = keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    uint8 constant NUM_FIELDS = 5;
    uint8 constant SPENDER_IDX = 1;
    uint8 constant AMOUNT_IDX = 2;
    uint8 constant DEADLINE_IDX = 4;

    bytes32 internal domainSep; // chainId-bound EIP-712 domain separator

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
        // the chainId-bound domain separator for the "protocol" the descriptor models.
        domainSep = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("CoWProtocol"),
                keccak256("1"),
                block.chainid,
                spender
            )
        );
    }

    // ---------- helpers ----------

    function _spenders(address a) internal pure returns (address[] memory s) {
        s = new address[](1);
        s[0] = a;
    }

    // FP-3: the flat `proposeSigningGrant` was removed (owners use the nested fn with a zeroed fold).
    // This helper preserves the FP-1 call convention, exercising the identical flat on-chain path.
    function _proposeFlat(
        uint256 id, bytes32 ds, bytes32 th, uint8 nf, uint8 si, uint8 ai, uint8 di,
        address token, uint128 cap, uint64 win, address[] memory sp
    ) internal {
        acct.proposeSigningGrantNested(
            SigningLib.SigningGrantParams(id, ds, th, nf, si, ai, di, type(uint8).max, bytes32(0), 0, 0, token, cap, win),
            sp
        );
    }

    function _budget(address token, uint128 cap) internal {
        vm.prank(owner);
        acct.proposeSpendBudget(token, cap);
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applySpendBudget();
    }

    /// Grant the descriptor + its signing rule (one atomic owner grant — "a protocol
    /// is a descriptor + grant", FP-e). Timelocked (loosening).
    function _grantSigning(address token, uint128 perIntentCap, uint64 maxDeadlineWindow, address sp) internal {
        vm.prank(owner);
        _proposeFlat(
            DESCRIPTOR_ID, domainSep, TYPEHASH, NUM_FIELDS, SPENDER_IDX, AMOUNT_IDX, DEADLINE_IDX, token,
            perIntentCap, maxDeadlineWindow, _spenders(sp)
        );
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applySigningGrant();
    }

    function _fields(address sp, uint256 amount, uint256 deadline) internal view returns (bytes32[] memory f) {
        f = new bytes32[](NUM_FIELDS);
        f[0] = bytes32(uint256(uint160(owner)));
        f[1] = bytes32(uint256(uint160(sp)));
        f[2] = bytes32(amount);
        f[3] = bytes32(uint256(7)); // nonce
        f[4] = bytes32(deadline);
    }

    function _digest(bytes32[] memory f) internal view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encodePacked(TYPEHASH, f));
        return keccak256(abi.encodePacked(hex"1901", domainSep, structHash));
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// The full happy-path arm: returns the armed digest.
    function _arm(address sp, uint256 amount, uint256 deadline) internal returns (bytes32 digest) {
        bytes32[] memory f = _fields(sp, amount, deadline);
        digest = _digest(f);
        bytes memory sig = _sign(sessionPk, digest);
        vm.prank(session);
        acct.authorizeSigningIntent(DESCRIPTOR_ID, f, sig);
    }

    // ============ FP-a: magic value ONLY for an in-policy armed intent ============

    function test_FPa_armedInPolicyIntent_isValid() public {
        _budget(address(usd), 500 ether);
        _grantSigning(address(usd), 100 ether, 1 hours, spender);
        bytes32 digest = _arm(spender, 100 ether, block.timestamp + 30 minutes);
        assertEq(acct.isValidSignature(digest, ""), ERC1271_MAGIC, "in-policy armed intent must be valid");
    }

    function test_FPa_unarmedIntent_isInvalid() public view {
        // default-deny: a digest that was never armed is invalid.
        bytes32 digest = _digest(_fields(spender, 100 ether, block.timestamp + 30 minutes));
        assertEq(acct.isValidSignature(digest, ""), ERC1271_INVALID, "unarmed digest must be invalid");
    }

    function test_FPa_overCapAmount_revertsAtArm() public {
        _budget(address(usd), 500 ether);
        _grantSigning(address(usd), 100 ether, 1 hours, spender);
        bytes32[] memory f = _fields(spender, 100 ether + 1, block.timestamp + 30 minutes);
        bytes memory sig = _sign(sessionPk, _digest(f));
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV5.OverPerIntentCap.selector, 100 ether + 1, uint128(100 ether)));
        acct.authorizeSigningIntent(DESCRIPTOR_ID, f, sig);
    }

    function test_FPa_wrongSpender_revertsAtArm() public {
        _budget(address(usd), 500 ether);
        _grantSigning(address(usd), 100 ether, 1 hours, spender);
        bytes32[] memory f = _fields(attacker, 10 ether, block.timestamp + 30 minutes);
        bytes memory sig = _sign(sessionPk, _digest(f));
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV5.SpenderNotAllowlisted.selector, attacker));
        acct.authorizeSigningIntent(DESCRIPTOR_ID, f, sig);
    }

    function test_FPa_expiredDeadline_revertsAtArm() public {
        _budget(address(usd), 500 ether);
        _grantSigning(address(usd), 100 ether, 1 hours, spender);
        bytes32[] memory f = _fields(spender, 10 ether, block.timestamp - 1);
        bytes memory sig = _sign(sessionPk, _digest(f));
        vm.prank(session);
        vm.expectRevert(LeashAccountV5.DeadlineInPast.selector);
        acct.authorizeSigningIntent(DESCRIPTOR_ID, f, sig);
    }

    function test_FPa_deadlineTooFar_revertsAtArm() public {
        _budget(address(usd), 500 ether);
        _grantSigning(address(usd), 100 ether, 1 hours, spender);
        uint256 tooFar = block.timestamp + 2 hours;
        bytes32[] memory f = _fields(spender, 10 ether, tooFar);
        bytes memory sig = _sign(sessionPk, _digest(f));
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV5.DeadlineTooFar.selector, tooFar));
        acct.authorizeSigningIntent(DESCRIPTOR_ID, f, sig);
    }

    function test_FPa_armedIntentExpires_becomesInvalid() public {
        _budget(address(usd), 500 ether);
        _grantSigning(address(usd), 100 ether, 1 hours, spender);
        uint256 deadline = block.timestamp + 30 minutes;
        bytes32 digest = _arm(spender, 100 ether, deadline);
        assertEq(acct.isValidSignature(digest, ""), ERC1271_MAGIC);
        vm.warp(deadline + 1);
        assertEq(acct.isValidSignature(digest, ""), ERC1271_INVALID, "expired armed intent must be invalid");
    }

    // ============ FP-a: revoke fails-closed ============

    function test_FPa_revoke_failsClosed() public {
        _budget(address(usd), 500 ether);
        _grantSigning(address(usd), 100 ether, 1 hours, spender);
        bytes32 digest = _arm(spender, 100 ether, block.timestamp + 30 minutes);
        assertEq(acct.isValidSignature(digest, ""), ERC1271_MAGIC);
        vm.prank(guardian);
        acct.revoke();
        assertEq(acct.isValidSignature(digest, ""), ERC1271_INVALID, "revoke must fail-close signing");
    }

    function test_FPa_cannotArmWhenRevoked() public {
        _budget(address(usd), 500 ether);
        _grantSigning(address(usd), 100 ether, 1 hours, spender);
        vm.prank(owner);
        acct.revoke();
        bytes32[] memory f = _fields(spender, 10 ether, block.timestamp + 30 minutes);
        bytes memory sig = _sign(sessionPk, _digest(f));
        vm.prank(session);
        vm.expectRevert(LeashAccountV5.AccountRevoked.selector);
        acct.authorizeSigningIntent(DESCRIPTOR_ID, f, sig);
    }

    // ============ FP-b: signing ≤ calling (shared per-token budget) ============

    function test_FPb_signingDebitsSharedBudget() public {
        _budget(address(usd), 150 ether);
        _grantSigning(address(usd), 100 ether, 1 hours, spender);
        _arm(spender, 100 ether, block.timestamp + 30 minutes);
        (,, uint128 spent,) = acct.spendBudget(address(usd));
        assertEq(spent, 100 ether, "signing must debit the shared per-token budget");
    }

    function test_FPb_signingPlusCall_cannotDoubleSpendBudget() public {
        // budget 150; a 100-ether signed permit debits 100; a later direct transfer of
        // 60 would push cumulative to 160 > 150 → refused. signing + settle ≤ budget.
        _budget(address(usd), 150 ether);
        _grantSigning(address(usd), 100 ether, 1 hours, spender);
        vm.prank(owner);
        acct.proposeCallRule(address(usd), 0xa9059cbb, 0, new address[](0), 100 ether, 1_000 ether, bytes32(0));
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applyCallRule();

        _arm(spender, 100 ether, block.timestamp + 30 minutes); // debits 100
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV5.OverCumulativeSpend.selector, 160 ether, uint128(150 ether)));
        acct.executeCall(address(usd), 0, abi.encodeWithSelector(bytes4(0xa9059cbb), address(acct), 60 ether));
    }

    function test_FPb_noBudget_revertsAtArm() public {
        // signing with no per-token budget set is refused (fail-closed, no free signing allowance).
        _grantSigning(address(usd), 100 ether, 1 hours, spender);
        bytes32[] memory f = _fields(spender, 10 ether, block.timestamp + 30 minutes);
        bytes memory sig = _sign(sessionPk, _digest(f));
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV5.BudgetNotSet.selector, address(usd)));
        acct.authorizeSigningIntent(DESCRIPTOR_ID, f, sig);
    }

    // ============ FP-d: replay + laddering ============

    function test_FPd_crossChainDomain_notArmed() public {
        // A digest built against a DIFFERENT-chain domain separator is never armed here.
        _budget(address(usd), 500 ether);
        _grantSigning(address(usd), 100 ether, 1 hours, spender);
        _arm(spender, 100 ether, block.timestamp + 30 minutes); // arms the in-chain digest
        bytes32 foreignDomain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("CoWProtocol"), keccak256("1"), block.chainid + 1, spender
            )
        );
        bytes32 foreignStruct = keccak256(abi.encodePacked(TYPEHASH, _fields(spender, 100 ether, block.timestamp + 30 minutes)));
        bytes32 foreignDigest = keccak256(abi.encodePacked(hex"1901", foreignDomain, foreignStruct));
        assertEq(acct.isValidSignature(foreignDigest, ""), ERC1271_INVALID, "cross-chain digest must not be armed");
    }

    function test_FPd_laddering_cumulativeBudgetCatches() public {
        // many small in-policy signs, each ≤ perIntentCap, summing past the budget.
        _budget(address(usd), 150 ether);
        _grantSigning(address(usd), 100 ether, 1 hours, spender);
        _arm(spender, 80 ether, block.timestamp + 30 minutes); // 80
        // second 80 → 160 > 150 cumulative budget → refused
        bytes32[] memory f = _fields(spender, 80 ether, block.timestamp + 31 minutes);
        bytes memory sig = _sign(sessionPk, _digest(f));
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV5.OverCumulativeSpend.selector, 160 ether, uint128(150 ether)));
        acct.authorizeSigningIntent(DESCRIPTOR_ID, f, sig);
    }

    // ============ FP-e: config-extensibility (descriptor-add = no code change) ============

    function test_FPe_secondDescriptor_tableDriven() public {
        _budget(address(usd), 500 ether);
        _grantSigning(address(usd), 100 ether, 1 hours, spender);

        // onboard a SECOND protocol as descriptor id 2 — a different domain/type, NO
        // contract change — proving the registry is table-driven (FP-e).
        uint256 id2 = 2;
        bytes32 domain2 = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Permit2"), keccak256("1"), block.chainid, attacker
            )
        );
        bytes32 type2 = keccak256("Approve(address spender,uint256 amount,uint256 deadline)");
        address sp2 = makeAddr("permit2Spender");
        address[] memory s2 = new address[](1);
        s2[0] = sp2;
        vm.prank(owner);
        _proposeFlat(id2, domain2, type2, 3, 0, 1, 2, address(usd), 50 ether, 1 hours, s2);
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applySigningGrant();

        bytes32[] memory f = new bytes32[](3);
        f[0] = bytes32(uint256(uint160(sp2)));
        f[1] = bytes32(uint256(40 ether));
        f[2] = bytes32(block.timestamp + 10 minutes);
        bytes32 structHash = keccak256(abi.encodePacked(type2, f));
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", domain2, structHash));
        bytes memory sig = _sign(sessionPk, digest);
        vm.prank(session);
        acct.authorizeSigningIntent(id2, f, sig);
        assertEq(acct.isValidSignature(digest, ""), ERC1271_MAGIC, "second descriptor must work with no code change");
    }

    function test_FPe_unregisteredDescriptor_refused() public {
        _budget(address(usd), 500 ether);
        // descriptor 99 was never granted → default-deny.
        bytes32[] memory f = _fields(spender, 10 ether, block.timestamp + 30 minutes);
        bytes memory sig = _sign(sessionPk, _digest(f));
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV5.DescriptorNotRegistered.selector, uint256(99)));
        acct.authorizeSigningIntent(99, f, sig);
    }

    // ============ FP-h: adversarial ============

    function test_FPh_forgedIntent_notSignedBySession_reverts() public {
        _budget(address(usd), 500 ether);
        _grantSigning(address(usd), 100 ether, 1 hours, spender);
        (, uint256 attackerPk) = makeAddrAndKey("attackerKey");
        bytes32[] memory f = _fields(spender, 10 ether, block.timestamp + 30 minutes);
        bytes memory sig = _sign(attackerPk, _digest(f)); // signed by the WRONG key
        vm.prank(session);
        vm.expectRevert(LeashAccountV5.BadIntentSignature.selector);
        acct.authorizeSigningIntent(DESCRIPTOR_ID, f, sig);
    }

    function test_FPh_fieldCountMismatch_reverts() public {
        _budget(address(usd), 500 ether);
        _grantSigning(address(usd), 100 ether, 1 hours, spender);
        bytes32[] memory f = new bytes32[](4); // descriptor declares 5
        bytes memory sig = _sign(sessionPk, keccak256("x"));
        vm.prank(session);
        vm.expectRevert(LeashAccountV5.DecodeMismatch.selector);
        acct.authorizeSigningIntent(DESCRIPTOR_ID, f, sig);
    }

    function test_FPh_dirtySpenderBits_reverts() public {
        _budget(address(usd), 500 ether);
        _grantSigning(address(usd), 100 ether, 1 hours, spender);
        bytes32[] memory f = _fields(spender, 10 ether, block.timestamp + 30 minutes);
        f[SPENDER_IDX] = bytes32(uint256(0xdead) << 160 | uint256(uint160(spender))); // dirty high bits
        bytes memory sig = _sign(sessionPk, _digest(f));
        vm.prank(session);
        vm.expectRevert(LeashAccountV5.DecodeMismatch.selector);
        acct.authorizeSigningIntent(DESCRIPTOR_ID, f, sig);
    }

    function test_FPh_agentCannotGrantOwnDescriptor() public {
        vm.prank(session);
        vm.expectRevert(LeashAccountV5.NotOwner.selector);
        _proposeFlat(
            7, domainSep, TYPEHASH, NUM_FIELDS, SPENDER_IDX, AMOUNT_IDX, DEADLINE_IDX, address(usd),
            1e30, 1 hours, _spenders(attacker)
        );
    }

    // ============ grant grammar: tighten instant, remove instant, default-deny ============

    function test_grant_tightenLowersCap_instant() public {
        _budget(address(usd), 500 ether);
        _grantSigning(address(usd), 100 ether, 1 hours, spender);
        vm.prank(owner);
        acct.tightenSigningGrant(DESCRIPTOR_ID, 10 ether, 1 hours); // lower cap
        bytes32[] memory f = _fields(spender, 20 ether, block.timestamp + 30 minutes);
        bytes memory sig = _sign(sessionPk, _digest(f));
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV5.OverPerIntentCap.selector, 20 ether, uint128(10 ether)));
        acct.authorizeSigningIntent(DESCRIPTOR_ID, f, sig);
    }

    function test_grant_tightenCannotRaise_reverts() public {
        _budget(address(usd), 500 ether);
        _grantSigning(address(usd), 100 ether, 1 hours, spender);
        vm.prank(owner);
        vm.expectRevert(LeashAccountV5.NotTightening.selector);
        acct.tightenSigningGrant(DESCRIPTOR_ID, 200 ether, 1 hours);
    }

    function test_grant_removeDescriptor_defaultDeniesAgain() public {
        _budget(address(usd), 500 ether);
        _grantSigning(address(usd), 100 ether, 1 hours, spender);
        vm.prank(owner);
        acct.removeSigningDescriptor(DESCRIPTOR_ID);
        bytes32[] memory f = _fields(spender, 10 ether, block.timestamp + 30 minutes);
        bytes memory sig = _sign(sessionPk, _digest(f));
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV5.DescriptorNotRegistered.selector, DESCRIPTOR_ID));
        acct.authorizeSigningIntent(DESCRIPTOR_ID, f, sig);
    }

    // ============ edge cases (code-review gate) ============

    function test_edge_zeroAmountIntent_armsWithoutBudget() public {
        // a zero-notional intent (e.g. cancel/zero-approval) arms even with NO budget —
        // it moves no value, so the budget debit is skipped by design.
        _grantSigning(address(usd), 100 ether, 1 hours, spender); // no _budget() call
        bytes32 digest = _arm(spender, 0, block.timestamp + 10 minutes);
        assertEq(acct.isValidSignature(digest, ""), ERC1271_MAGIC, "zero-notional intent arms without a budget");
    }

    function test_edge_deadlineExactlyNow_rejected() public {
        _budget(address(usd), 500 ether);
        _grantSigning(address(usd), 100 ether, 1 hours, spender);
        bytes32[] memory f = _fields(spender, 10 ether, block.timestamp); // deadline == now
        bytes memory sig = _sign(sessionPk, _digest(f));
        vm.prank(session);
        vm.expectRevert(LeashAccountV5.DeadlineInPast.selector);
        acct.authorizeSigningIntent(DESCRIPTOR_ID, f, sig);
    }

    function test_edge_validAtExactExpiry() public {
        _budget(address(usd), 500 ether);
        _grantSigning(address(usd), 100 ether, 1 hours, spender);
        uint256 deadline = block.timestamp + 20 minutes;
        bytes32 digest = _arm(spender, 50 ether, deadline);
        vm.warp(deadline); // exactly at expiry
        assertEq(acct.isValidSignature(digest, ""), ERC1271_MAGIC, "valid at exactly expiry (<=)");
        vm.warp(deadline + 1);
        assertEq(acct.isValidSignature(digest, ""), ERC1271_INVALID, "invalid one second past expiry");
    }

    function test_edge_reGrantDropsOldSpender() public {
        _budget(address(usd), 500 ether);
        _grantSigning(address(usd), 100 ether, 1 hours, spender); // spender granted
        // re-grant the SAME descriptor with a DIFFERENT spender only
        address sp2 = makeAddr("newSpender");
        _grantSigning(address(usd), 100 ether, 1 hours, sp2);
        // the OLD spender must now be denied (set was replaced, not merged)
        bytes32[] memory f = _fields(spender, 10 ether, block.timestamp + 10 minutes);
        bytes memory sig = _sign(sessionPk, _digest(f));
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV5.SpenderNotAllowlisted.selector, spender));
        acct.authorizeSigningIntent(DESCRIPTOR_ID, f, sig);
    }

    function test_edge_ownerDisarmsSingleIntent() public {
        _budget(address(usd), 500 ether);
        _grantSigning(address(usd), 100 ether, 1 hours, spender);
        bytes32 digest = _arm(spender, 50 ether, block.timestamp + 20 minutes);
        assertEq(acct.isValidSignature(digest, ""), ERC1271_MAGIC);
        vm.prank(owner);
        acct.disarmSigningIntent(digest);
        assertEq(acct.isValidSignature(digest, ""), ERC1271_INVALID, "disarmed intent must be invalid");
    }

    function test_edge_nonOwnerCannotDisarm() public {
        _budget(address(usd), 500 ether);
        _grantSigning(address(usd), 100 ether, 1 hours, spender);
        bytes32 digest = _arm(spender, 50 ether, block.timestamp + 20 minutes);
        vm.prank(session);
        vm.expectRevert(LeashAccountV5.NotOwner.selector);
        acct.disarmSigningIntent(digest);
    }

    // ============ fuzz over descriptor field-mappings ============

    function testFuzz_FPa_amountBoundedByCap(uint256 amount, uint256 dOffset) public {
        _budget(address(usd), type(uint128).max);
        _grantSigning(address(usd), 100 ether, 1 hours, spender);
        amount = bound(amount, 0, 1_000 ether);
        dOffset = bound(dOffset, 1, 1 hours);
        uint256 deadline = block.timestamp + dOffset;
        bytes32[] memory f = _fields(spender, amount, deadline);
        bytes memory sig = _sign(sessionPk, _digest(f));
        vm.prank(session);
        if (amount > 100 ether) {
            vm.expectRevert(abi.encodeWithSelector(LeashAccountV5.OverPerIntentCap.selector, amount, uint128(100 ether)));
            acct.authorizeSigningIntent(DESCRIPTOR_ID, f, sig);
        } else {
            bytes32 digest = acct.authorizeSigningIntent(DESCRIPTOR_ID, f, sig);
            assertEq(acct.isValidSignature(digest, ""), ERC1271_MAGIC);
        }
    }

    // ============ FP-CARRY-5 / D-FP1-7: re-arm idempotency + arming-epoch ============

    function _spent() internal view returns (uint128 spent) {
        (,, spent,) = acct.spendBudget(address(usd));
    }

    /// Re-arming a STILL-LIVE digest reverts (no double-debit of the shared budget).
    function test_CARRY5_rearmLiveDigest_reverts() public {
        _budget(address(usd), 500 ether);
        _grantSigning(address(usd), 100 ether, 1 hours, spender);
        uint256 dl = block.timestamp + 30 minutes;
        _arm(spender, 100 ether, dl);
        assertEq(_spent(), 100 ether, "first arm debits once");
        bytes32[] memory f = _fields(spender, 100 ether, dl); // identical fields ⇒ same digest
        bytes memory sig = _sign(sessionPk, _digest(f));
        vm.prank(session);
        vm.expectRevert(LeashAccountV5.AlreadyArmed.selector);
        acct.authorizeSigningIntent(DESCRIPTOR_ID, f, sig);
        assertEq(_spent(), 100 ether, "reverted re-arm must NOT debit again");
    }

    /// Tightening the signing grant invalidates every in-flight armed intent (epoch bump).
    function test_CARRY5_tightenGrant_invalidatesArmed() public {
        _budget(address(usd), 500 ether);
        _grantSigning(address(usd), 100 ether, 1 hours, spender);
        bytes32 d = _arm(spender, 100 ether, block.timestamp + 30 minutes);
        assertEq(acct.isValidSignature(d, ""), ERC1271_MAGIC, "valid before tighten");
        vm.prank(owner);
        acct.tightenSigningGrant(DESCRIPTOR_ID, 50 ether, 1 hours); // lower cap
        assertEq(acct.isValidSignature(d, ""), ERC1271_INVALID, "stale arm invalid after tighten");
    }

    /// Tightening the SHARED per-token budget also invalidates in-flight arms.
    function test_CARRY5_tightenBudget_invalidatesArmed() public {
        _budget(address(usd), 500 ether);
        _grantSigning(address(usd), 100 ether, 1 hours, spender);
        bytes32 d = _arm(spender, 100 ether, block.timestamp + 30 minutes);
        assertEq(acct.isValidSignature(d, ""), ERC1271_MAGIC);
        vm.prank(owner);
        acct.tightenSpendBudget(address(usd), 300 ether);
        assertEq(acct.isValidSignature(d, ""), ERC1271_INVALID, "budget tighten kills stale arm");
    }

    /// Removing the descriptor (default-deny again) invalidates in-flight arms.
    function test_CARRY5_removeDescriptor_invalidatesArmed() public {
        _budget(address(usd), 500 ether);
        _grantSigning(address(usd), 100 ether, 1 hours, spender);
        bytes32 d = _arm(spender, 100 ether, block.timestamp + 30 minutes);
        assertEq(acct.isValidSignature(d, ""), ERC1271_MAGIC);
        vm.prank(owner);
        acct.removeSigningDescriptor(DESCRIPTOR_ID);
        assertEq(acct.isValidSignature(d, ""), ERC1271_INVALID, "removed descriptor kills stale arm");
    }

    /// revoke → rearm must NOT silently resurrect arms authorized before the revoke.
    function test_CARRY5_revokeThenRearm_doesNotResurrect() public {
        _budget(address(usd), 500 ether);
        _grantSigning(address(usd), 100 ether, 1 hours, spender);
        bytes32 d = _arm(spender, 100 ether, block.timestamp + 30 minutes);
        assertEq(acct.isValidSignature(d, ""), ERC1271_MAGIC);
        vm.prank(owner);
        acct.revoke();
        vm.prank(owner);
        acct.rearm();
        assertEq(acct.isValidSignature(d, ""), ERC1271_INVALID, "pre-revoke arm must stay dead after rearm");
    }

    /// A STALE (epoch-invalidated) digest MAY be re-armed — re-authorized under the
    /// now-current policy, debiting the budget afresh.
    function test_CARRY5_rearmStaleDigest_allowed() public {
        _budget(address(usd), 500 ether);
        _grantSigning(address(usd), 100 ether, 1 hours, spender);
        uint256 dl = block.timestamp + 30 minutes;
        bytes32 d = _arm(spender, 100 ether, dl);
        assertEq(_spent(), 100 ether);
        vm.prank(owner);
        acct.tightenSigningGrant(DESCRIPTOR_ID, 100 ether, 59 minutes); // tighten window only (epoch++)
        assertEq(acct.isValidSignature(d, ""), ERC1271_INVALID, "stale after tighten");
        bytes32 re = _arm(spender, 100 ether, dl); // same fields ⇒ same digest, now re-armable
        assertEq(re, d, "same fields => same digest");
        assertEq(acct.isValidSignature(d, ""), ERC1271_MAGIC, "re-armed valid under new epoch");
        assertEq(_spent(), 200 ether, "re-arm of a stale digest debits afresh");
    }

    // ============ FP-CARRY: descriptor role-index aliasing rejected at grant ============

    function test_CARRY_indexAliasing_reverts() public {
        vm.prank(owner);
        vm.expectRevert(LeashAccountV5.InvalidPolicy.selector);
        _proposeFlat(
            2, domainSep, TYPEHASH, NUM_FIELDS, SPENDER_IDX, AMOUNT_IDX, AMOUNT_IDX, address(usd),
            100 ether, 1 hours, _spenders(spender)
        ); // deadlineIndex == amountIndex ⇒ InvalidPolicy
    }
}
