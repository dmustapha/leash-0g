// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, stdError} from "forge-std/Test.sol";
import {LeashAccountV5} from "../src/LeashAccountV5.sol";
import {DecodeLib} from "../src/DecodeLib.sol";
import {SigningLib} from "../src/SigningLib.sol";
import {MockERC20} from "../src/MockERC20.sol";

/// Stage F′ FP-4 Slice-4 — CoW Protocol `GPv2Order` governed-signing family (the first `kind: order`).
///
/// A bound agent may sign a fully-pinned CoW SELL order; `authorizeSigningIntent` arms it and
/// `isValidSignature` returns the ERC-1271 magic while live — but the wall hard-bounds the outflow
/// (`sellAmount + feeAmount ≤ perIntentCap` on the SELLTOKEN budget), wall-pins all THREE address leaves
/// (sellToken==budget token, buyToken==reviewed proceeds token, receiver==self), pins appData/kind/
/// partiallyFillable/balances, and refuses any order that is not the reviewed shape. Order has NO spender
/// (`spenderIndex==0xFF`, I-1) — the allowlist check is skipped; the outflow bound is the whole guarantee.
contract SigningCowOrderTest is Test {
    LeashAccountV5 internal acct;
    MockERC20 internal sellTok; // sellToken == signing-budget token (18dp)
    MockERC20 internal buyTok; // reviewed per-pair proceeds token (G11(b))

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal session;
    uint256 internal sessionPk;
    address internal attacker = makeAddr("attacker");

    uint32 constant WINDOW_SECONDS = 1 hours;
    uint64 constant DELAY = 15 minutes;
    bytes4 constant ERC1271_MAGIC = 0x1626ba7e;
    bytes4 constant ERC1271_INVALID = 0xffffffff;

    uint256 constant DID = 30; // CoW descriptor-id namespace
    uint8 constant NUM_FIELDS = 12;
    uint8 constant KIND_ORDER = 1;

    // The canonical CoW GPv2Order EIP-712 type string (the three enum fields are `string` in the signature).
    string constant ORDER_TYPE_STRING =
        "Order(address sellToken,address buyToken,address receiver,uint256 sellAmount,uint256 buyAmount,uint32 validTo,bytes32 appData,uint256 feeAmount,string kind,bool partiallyFillable,string sellTokenBalance,string buyTokenBalance)";
    bytes32 constant ORDER_TYPE_HASH = keccak256(bytes(ORDER_TYPE_STRING));
    // The published/asserted value the spec pins (§3/§4.3) — recomputed independently here.
    bytes32 constant ORDER_TYPE_HASH_PUBLISHED =
        0xd5a25ba2e97094ad7d83dc28a6572da797d6b3e7fc6663bd93efb789fc17e489;
    bytes32 constant COW_KIND_SELL = keccak256("sell");
    bytes32 constant COW_BAL_ERC20 = keccak256("erc20");
    bytes32 constant COW_APPDATA_NONE = bytes32(0);

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
        sellTok = new MockERC20("Sell 18", "SELL", 18);
        buyTok = new MockERC20("Buy 18", "BUY", 18);
        address[] memory list = new address[](0);
        acct = new LeashAccountV5(
            owner, guardian, session, _policy(), list, DELAY, address(sellTok),
            LeashAccountV5.TokenPolicy(0, 0), address(new SigningLib()), address(new DecodeLib())
        );
        sellTok.mint(address(acct), 1_000 ether);
        // CoW GPv2Settlement-style domain (name "Gnosis Protocol", version "v2"), chainId-bound (N-01).
        domainSep = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Gnosis Protocol"),
                keccak256("v2"),
                block.chainid,
                makeAddr("settlement")
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

    /// Grant the CoW order descriptor: kind=1, spenderIndex=0xFF (no spender), 12 fields, sellAmount=3,
    /// validTo=5, buyToken wall-pinned, empty spender set.
    function _grantOrder(uint128 cap, uint64 win) internal {
        address[] memory noSpenders = new address[](0);
        vm.prank(owner);
        acct.proposeSigningGrantNested(
            SigningLib.SigningGrantParams(
                DID, domainSep, ORDER_TYPE_HASH, NUM_FIELDS,
                type(uint8).max, 3, 5, type(uint8).max, // spenderIdx=0xFF, amountIdx=3, deadlineIdx=5, expiry=0xFF
                bytes32(0), 0, 0, // flat
                address(sellTok), cap, win,
                KIND_ORDER, address(buyTok)
            ),
            noSpenders
        );
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applySigningGrant();
    }

    /// The 12 GPv2Order leaf words, fully pinned to the reviewed happy shape.
    function _orderFields(uint256 sellAmount, uint256 buyAmount, uint256 validTo, uint256 feeAmount)
        internal
        view
        returns (bytes32[] memory f)
    {
        f = new bytes32[](12);
        f[0] = bytes32(uint256(uint160(address(sellTok))));
        f[1] = bytes32(uint256(uint160(address(buyTok))));
        f[2] = bytes32(uint256(uint160(address(acct)))); // receiver == self
        f[3] = bytes32(sellAmount);
        f[4] = bytes32(buyAmount);
        f[5] = bytes32(validTo);
        f[6] = COW_APPDATA_NONE;
        f[7] = bytes32(feeAmount);
        f[8] = COW_KIND_SELL;
        f[9] = bytes32(uint256(0)); // partiallyFillable == false
        f[10] = COW_BAL_ERC20;
        f[11] = COW_BAL_ERC20;
    }

    function _digest(bytes32[] memory f) internal view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encodePacked(ORDER_TYPE_HASH, f));
        return keccak256(abi.encodePacked(hex"1901", domainSep, structHash));
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _arm(bytes32[] memory f) internal returns (bytes32 digest) {
        digest = _digest(f);
        bytes memory sig = _sign(sessionPk, digest);
        vm.prank(session);
        acct.authorizeSigningIntent(DID, f, sig, "");
    }

    function _submitExpectRevert(bytes32[] memory f, bytes memory expectedRevert) internal {
        bytes memory sig = _sign(sessionPk, _digest(f));
        vm.prank(session);
        vm.expectRevert(expectedRevert);
        acct.authorizeSigningIntent(DID, f, sig, "");
    }

    function _spent() internal view returns (uint128 spent) {
        (,, spent,) = acct.spendBudget(address(sellTok));
    }

    // ============ constant / typeHash parity (§3a / §7) ============

    function test_orderTypeHash_matchesPublished() public pure {
        assertEq(ORDER_TYPE_HASH, ORDER_TYPE_HASH_PUBLISHED, "ORDER_TYPE_HASH must equal CoW's published value");
        assertEq(COW_KIND_SELL, bytes32(0xf3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee346775), "keccak256(sell)");
        assertEq(COW_BAL_ERC20, bytes32(0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9), "keccak256(erc20)");
    }

    // ============ happy path ============

    function test_happy_armsReturnsMagic_andDebitsSellPlusFee() public {
        _budget(address(sellTok), 500 ether);
        _grantOrder(100 ether, 1 hours);
        uint256 vt = block.timestamp + 30 minutes;
        bytes32 digest = _arm(_orderFields(60 ether, 1000e6, vt, 1 ether));
        assertEq(acct.isValidSignature(digest, ""), ERC1271_MAGIC, "fully-pinned order must be valid while live");
        // I-2: the budget is debited by sellAmount + feeAmount (61), not just sellAmount (60).
        assertEq(_spent(), 61 ether, "budget debited by sellAmount + feeAmount (I-2)");
    }

    function test_happy_digestEqualsReconstruction() public {
        _budget(address(sellTok), 500 ether);
        _grantOrder(100 ether, 1 hours);
        uint256 vt = block.timestamp + 20 minutes;
        bytes32[] memory f = _orderFields(10 ether, 1, vt, 0);
        // The armed digest returned by the wall equals the FLAT EIP-712 digest recomputed over the real
        // ORDER_TYPE_HASH + the 12 leaf words — proving the on-chain reconstruction uses CoW's real hash.
        bytes32 armed = _arm(f);
        assertEq(armed, _digest(f), "wall digest == recomputed real-Order digest");
    }

    function test_happy_zeroFee_debitsSellOnly() public {
        _budget(address(sellTok), 500 ether);
        _grantOrder(100 ether, 1 hours);
        _arm(_orderFields(80 ether, 1, block.timestamp + 10 minutes, 0));
        assertEq(_spent(), 80 ether, "fee=0 debits sellAmount only");
    }

    // ============ confused-deputy wall-pins (§7 adversarial, all DecodeMismatch) ============

    function test_adv_receiverNotSelf_reverts() public {
        _budget(address(sellTok), 500 ether);
        _grantOrder(100 ether, 1 hours);
        bytes32[] memory f = _orderFields(10 ether, 1, block.timestamp + 10 minutes, 0);
        f[2] = bytes32(uint256(uint160(attacker))); // divert proceeds
        _submitExpectRevert(f, abi.encodeWithSelector(SigningLib.DecodeMismatch.selector));
    }

    function test_adv_sellTokenMismatch_reverts() public {
        _budget(address(sellTok), 500 ether);
        _grantOrder(100 ether, 1 hours);
        bytes32[] memory f = _orderFields(10 ether, 1, block.timestamp + 10 minutes, 0);
        f[0] = bytes32(uint256(uint160(address(buyTok)))); // wrong sell token
        _submitExpectRevert(f, abi.encodeWithSelector(SigningLib.DecodeMismatch.selector));
    }

    function test_adv_nonCanonicalReceiver_reverts() public {
        _budget(address(sellTok), 500 ether);
        _grantOrder(100 ether, 1 hours);
        bytes32[] memory f = _orderFields(10 ether, 1, block.timestamp + 10 minutes, 0);
        f[2] = bytes32(uint256(0xdead) << 160 | uint256(uint160(address(acct)))); // dirty upper bits
        _submitExpectRevert(f, abi.encodeWithSelector(SigningLib.DecodeMismatch.selector));
    }

    function test_adv_nonCanonicalSellToken_reverts() public {
        _budget(address(sellTok), 500 ether);
        _grantOrder(100 ether, 1 hours);
        bytes32[] memory f = _orderFields(10 ether, 1, block.timestamp + 10 minutes, 0);
        f[0] = bytes32(uint256(0x1) << 160 | uint256(uint160(address(sellTok))));
        _submitExpectRevert(f, abi.encodeWithSelector(SigningLib.DecodeMismatch.selector));
    }

    function test_adv_appDataNonZero_reverts() public {
        _budget(address(sellTok), 500 ether);
        _grantOrder(100 ether, 1 hours);
        bytes32[] memory f = _orderFields(10 ether, 1, block.timestamp + 10 minutes, 0);
        f[6] = keccak256("hook"); // a CIP-7 appData hook would ride along
        _submitExpectRevert(f, abi.encodeWithSelector(SigningLib.DecodeMismatch.selector));
    }

    function test_adv_kindNotSell_reverts() public {
        _budget(address(sellTok), 500 ether);
        _grantOrder(100 ether, 1 hours);
        bytes32[] memory f = _orderFields(10 ether, 1, block.timestamp + 10 minutes, 0);
        f[8] = keccak256("buy"); // inverts the cap semantics
        _submitExpectRevert(f, abi.encodeWithSelector(SigningLib.DecodeMismatch.selector));
    }

    function test_adv_partiallyFillableTrue_reverts() public {
        _budget(address(sellTok), 500 ether);
        _grantOrder(100 ether, 1 hours);
        bytes32[] memory f = _orderFields(10 ether, 1, block.timestamp + 10 minutes, 0);
        f[9] = bytes32(uint256(1));
        _submitExpectRevert(f, abi.encodeWithSelector(SigningLib.DecodeMismatch.selector));
    }

    function test_adv_sellBalanceNotErc20_reverts() public {
        _budget(address(sellTok), 500 ether);
        _grantOrder(100 ether, 1 hours);
        bytes32[] memory f = _orderFields(10 ether, 1, block.timestamp + 10 minutes, 0);
        f[10] = keccak256("external");
        _submitExpectRevert(f, abi.encodeWithSelector(SigningLib.DecodeMismatch.selector));
    }

    function test_adv_buyBalanceNotErc20_reverts() public {
        _budget(address(sellTok), 500 ether);
        _grantOrder(100 ether, 1 hours);
        bytes32[] memory f = _orderFields(10 ether, 1, block.timestamp + 10 minutes, 0);
        f[11] = keccak256("external");
        _submitExpectRevert(f, abi.encodeWithSelector(SigningLib.DecodeMismatch.selector));
    }

    // ============ G11(b) — buyToken wall-pin ============

    function test_g11_wrongBuyToken_reverts() public {
        _budget(address(sellTok), 500 ether);
        _grantOrder(100 ether, 1 hours);
        bytes32[] memory f = _orderFields(10 ether, 1, block.timestamp + 10 minutes, 0);
        f[1] = bytes32(uint256(uint160(attacker))); // not the reviewed proceeds token
        _submitExpectRevert(f, abi.encodeWithSelector(SigningLib.DecodeMismatch.selector));
    }

    function test_g11_nonCanonicalBuyToken_reverts() public {
        _budget(address(sellTok), 500 ether);
        _grantOrder(100 ether, 1 hours);
        bytes32[] memory f = _orderFields(10 ether, 1, block.timestamp + 10 minutes, 0);
        f[1] = bytes32(uint256(0xbeef) << 160 | uint256(uint160(address(buyTok))));
        _submitExpectRevert(f, abi.encodeWithSelector(SigningLib.DecodeMismatch.selector));
    }

    function test_g11_grantBuyTokenZero_revertsAtGrant() public {
        address[] memory noSpenders = new address[](0);
        vm.prank(owner);
        vm.expectRevert(SigningLib.ZeroAddress.selector);
        acct.proposeSigningGrantNested(
            SigningLib.SigningGrantParams(
                DID, domainSep, ORDER_TYPE_HASH, NUM_FIELDS,
                type(uint8).max, 3, 5, type(uint8).max, bytes32(0), 0, 0,
                address(sellTok), 100 ether, 1 hours, KIND_ORDER, address(0) // buyToken == 0
            ),
            noSpenders
        );
    }

    // ============ caps / deadline / overflow ============

    function test_cap_sellPlusFeeOverCap_reverts() public {
        _budget(address(sellTok), 500 ether);
        _grantOrder(100 ether, 1 hours);
        // sellAmount 100 + fee 1 = 101 > cap 100 — the fee is folded into the cap (no fee-drain).
        bytes32[] memory f = _orderFields(100 ether, 1, block.timestamp + 10 minutes, 1 ether);
        _submitExpectRevert(f, abi.encodeWithSelector(SigningLib.OverPerIntentCap.selector, uint256(101 ether), uint128(100 ether)));
    }

    function test_cap_feeAloneCanPushOverCap() public {
        _budget(address(sellTok), 500 ether);
        _grantOrder(100 ether, 1 hours);
        // sellAmount 60 is under cap; fee 50 pushes the sum to 110 > 100.
        bytes32[] memory f = _orderFields(60 ether, 1, block.timestamp + 10 minutes, 50 ether);
        _submitExpectRevert(f, abi.encodeWithSelector(SigningLib.OverPerIntentCap.selector, uint256(110 ether), uint128(100 ether)));
    }

    function test_overflow_c2_sumNear2pow256_panics() public {
        _budget(address(sellTok), 500 ether);
        _grantOrder(100 ether, 1 hours);
        // sellAmount + feeAmount near 2²⁵⁶ ⇒ the Solidity 0.8 CHECKED add Panic(0x11)-reverts fail-closed
        // BEFORE the cap check (no arm, no debit) — C-2.
        bytes32[] memory f = _orderFields(type(uint256).max, 1, block.timestamp + 10 minutes, 2);
        _submitExpectRevert(f, abi.encodeWithSelector(bytes4(0x4e487b71), uint256(0x11))); // Panic(uint256) arithmetic
        assertEq(_spent(), 0, "overflow pre-cap-check: no debit");
    }

    function test_deadline_validToInPast_reverts() public {
        _budget(address(sellTok), 500 ether);
        _grantOrder(100 ether, 1 hours);
        bytes32[] memory f = _orderFields(10 ether, 1, block.timestamp - 1, 0);
        _submitExpectRevert(f, abi.encodeWithSelector(SigningLib.DeadlineInPast.selector));
    }

    function test_deadline_validToTooFar_reverts() public {
        _budget(address(sellTok), 500 ether);
        _grantOrder(100 ether, 1 hours);
        uint256 tooFar = block.timestamp + 2 hours;
        bytes32[] memory f = _orderFields(10 ether, 1, tooFar, 0);
        _submitExpectRevert(f, abi.encodeWithSelector(SigningLib.DeadlineTooFar.selector, tooFar));
    }

    // ============ discriminant isolation (I-1) ============

    function test_i1_orderGrantWithSpenderIndex_reverts() public {
        address[] memory sp = new address[](1);
        sp[0] = attacker;
        vm.prank(owner);
        vm.expectRevert(SigningLib.InvalidPolicy.selector);
        acct.proposeSigningGrantNested(
            SigningLib.SigningGrantParams(
                DID, domainSep, ORDER_TYPE_HASH, NUM_FIELDS,
                1, 3, 5, type(uint8).max, bytes32(0), 0, 0, // spenderIdx=1 (NOT 0xFF) for an order
                address(sellTok), 100 ether, 1 hours, KIND_ORDER, address(buyTok)
            ),
            sp
        );
    }

    function test_i1_standardGrantWith0xFFSpender_reverts() public {
        // A KIND_STANDARD descriptor carrying spenderIndex=0xFF must revert (255 ≥ totalLeaves).
        address[] memory sp = new address[](1);
        sp[0] = attacker;
        vm.prank(owner);
        vm.expectRevert(SigningLib.InvalidPolicy.selector);
        acct.proposeSigningGrantNested(
            SigningLib.SigningGrantParams(
                31, domainSep, ORDER_TYPE_HASH, 5,
                type(uint8).max, 1, 2, type(uint8).max, bytes32(0), 0, 0,
                address(sellTok), 100 ether, 1 hours, 0, address(0) // kind=STANDARD, spenderIdx=0xFF
            ),
            sp
        );
    }

    function test_i1_orderGrantWrongFieldCount_reverts() public {
        address[] memory noSpenders = new address[](0);
        vm.prank(owner);
        vm.expectRevert(SigningLib.InvalidPolicy.selector);
        acct.proposeSigningGrantNested(
            SigningLib.SigningGrantParams(
                DID, domainSep, ORDER_TYPE_HASH, 11, // not 12
                type(uint8).max, 3, 5, type(uint8).max, bytes32(0), 0, 0,
                address(sellTok), 100 ether, 1 hours, KIND_ORDER, address(buyTok)
            ),
            noSpenders
        );
    }

    function test_i1_orderHasNoSpenderAllowlistCheck() public {
        // The order arms with an EMPTY spender set — proving the allowlist check is skipped for order
        // (I-1). The outflow is still bounded (receiver==self, cap, sellToken==budget token).
        _budget(address(sellTok), 500 ether);
        _grantOrder(100 ether, 1 hours);
        bytes32 digest = _arm(_orderFields(10 ether, 1, block.timestamp + 10 minutes, 0));
        assertEq(acct.isValidSignature(digest, ""), ERC1271_MAGIC, "order arms with no spender in the set");
    }

    // ============ fail-safe parity with the money triad ============

    function test_parity_revokeFailsClosed() public {
        _budget(address(sellTok), 500 ether);
        _grantOrder(100 ether, 1 hours);
        bytes32 digest = _arm(_orderFields(10 ether, 1, block.timestamp + 10 minutes, 0));
        vm.prank(guardian);
        acct.revoke();
        assertEq(acct.isValidSignature(digest, ""), ERC1271_INVALID, "revoke fail-closes an armed order");
    }

    function test_parity_tightenInvalidatesArmedOrder() public {
        _budget(address(sellTok), 500 ether);
        _grantOrder(100 ether, 1 hours);
        bytes32 digest = _arm(_orderFields(60 ether, 1, block.timestamp + 10 minutes, 1 ether));
        assertEq(acct.isValidSignature(digest, ""), ERC1271_MAGIC);
        vm.prank(owner);
        acct.tightenSigningGrant(DID, 50 ether, 1 hours);
        assertEq(acct.isValidSignature(digest, ""), ERC1271_INVALID, "tighten kills the stale armed order");
    }
}
