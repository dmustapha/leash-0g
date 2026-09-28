// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {LeashAccountV4} from "../src/LeashAccountV4.sol";
import {V4DecoderHarness} from "./harness/V4DecoderHarness.sol";
import {MockERC20} from "../src/MockERC20.sol";

/// D-15 DIFFERENTIAL DECODE ORACLE.
/// The on-chain decoder's parse is diffed against a TRUSTED off-chain decoder (viem,
/// via `script/gen-corpus.mjs`) over a REAL-CALLDATA corpus (`test/corpus/corpus.json`
/// — real Uniswap V2/V3, Aave supply, approve, Permit2 permit, multicall + malicious
/// mutations). Any divergence = a failing test. This is the rigorous form of the H-04
/// (decode-vs-execute divergence) defense: it proves the wall parses real-world
/// encodings identically to viem, and reverts on non-canonical / dirty-bit / redirect
/// mutations — proven against REAL bytes, not tidy mocks.
contract LeashAccountV4DifferentialTest is Test {
    V4DecoderHarness internal h;
    LeashAccountV4 internal acct;
    MockERC20 internal usd;

    address internal owner = makeAddr("owner");
    address internal session = makeAddr("session");
    address internal dest = makeAddr("dest");

    bytes4 constant SEL_APPROVE = 0x095ea7b3;
    bytes4 constant SEL_TRANSFER = 0xa9059cbb;
    bytes4 constant SEL_TRANSFER_FROM = 0x23b872dd;
    bytes4 constant SEL_SET_APPROVAL_FOR_ALL = 0xa22cb465;

    string internal json;

    function setUp() public {
        vm.warp(1_700_000_000);
        h = new V4DecoderHarness(owner, session);
        usd = new MockERC20("USD", "USD", 6);
        json = vm.readFile("test/corpus/corpus.json");
    }

    function _count() internal view returns (uint256) {
        return vm.parseJsonUint(json, ".count");
    }

    function _s(uint256 i, string memory field) internal view returns (string memory) {
        return vm.parseJsonString(json, string.concat(".entries[", vm.toString(i), "]", field));
    }

    function _has(uint256 i, string memory field) internal view returns (bool) {
        return vm.keyExistsJson(json, string.concat(".entries[", vm.toString(i), "]", field));
    }

    function _bool(uint256 i, string memory field) internal view returns (bool) {
        if (!_has(i, field)) return false;
        return vm.parseJsonBool(json, string.concat(".entries[", vm.toString(i), "]", field));
    }

    function _bytes(uint256 i) internal view returns (bytes memory) {
        return vm.parseJsonBytes(json, string.concat(".entries[", vm.toString(i), "].data"));
    }

    /// The corpus canonical structured entries: on-chain decode == viem-declared expect.
    function test_differential_structuredDecodeMatchesViem() public view {
        uint256 n = _count();
        uint256 checked;
        for (uint256 i = 0; i < n; i++) {
            if (_bool(i, ".mutation")) continue;
            string memory kind = _s(i, ".kind");
            if (_eq(kind, "nonstructured")) continue;
            bytes memory data = _bytes(i);
            bytes32 k = keccak256(bytes(kind));

            if (k == keccak256("approve") || k == keccak256("transfer")) {
                // layout: [0:4] sel, [4:36] address, [36:68] amount
                address a0 = h.decodeAddress(data, 4);
                uint256 amt = h.decodeUint(data, 36);
                assertEq(a0, _addr(i, ".expect.addr0"), _s(i, ".name"));
                assertEq(amt, _uintStr(_s(i, ".expect.amount")), _s(i, ".name"));
                checked++;
            } else if (k == keccak256("transferFrom")) {
                address a0 = h.decodeAddress(data, 4);
                address a1 = h.decodeAddress(data, 36);
                uint256 amt = h.decodeUint(data, 68);
                assertEq(a0, _addr(i, ".expect.addr0"), _s(i, ".name"));
                assertEq(a1, _addr(i, ".expect.addr1"), _s(i, ".name"));
                assertEq(amt, _uintStr(_s(i, ".expect.amount")), _s(i, ".name"));
                checked++;
            } else if (k == keccak256("setApprovalForAll")) {
                address a0 = h.decodeAddress(data, 4);
                assertEq(a0, _addr(i, ".expect.addr0"), _s(i, ".name"));
                checked++;
            } else if (k == keccak256("deposit")) {
                // deposit(uint256 assets, address receiver): amount @ 4, receiver @ 36
                uint256 amt = h.decodeUint(data, 4);
                address a0 = h.decodeAddress(data, 36);
                assertEq(amt, _uintStr(_s(i, ".expect.amount")), _s(i, ".name"));
                assertEq(a0, _addr(i, ".expect.addr0"), _s(i, ".name"));
                checked++;
            }
        }
        assertGe(checked, 5, "expected >=5 structured corpus entries");
    }

    /// Dirty-high-bits on an address word MUST revert DecodeMismatch (the real primitive).
    function test_differential_dirtyAddressBits_revert() public {
        uint256 n = _count();
        bool ranOne;
        for (uint256 i = 0; i < n; i++) {
            if (!_bool(i, ".mutation")) continue;
            if (!_eq(_s(i, ".name"), "approve_dirty_addr_high_bits")) continue;
            bytes memory data = _bytes(i);
            vm.expectRevert(LeashAccountV4.DecodeMismatch.selector);
            h.decodeAddress(data, 4);
            ranOne = true;
        }
        assertTrue(ranOne, "dirty-bits mutation not found in corpus");
    }

    /// Dirty-high-bits on the deposit RECEIVER word (offset 36) MUST revert DecodeMismatch.
    function test_differential_depositDirtyReceiverBits_revert() public {
        uint256 n = _count();
        bool ranOne;
        for (uint256 i = 0; i < n; i++) {
            if (!_bool(i, ".mutation")) continue;
            if (!_eq(_s(i, ".name"), "deposit_dirty_receiver_high_bits")) continue;
            bytes memory data = _bytes(i);
            vm.expectRevert(LeashAccountV4.DecodeMismatch.selector);
            h.decodeAddress(data, 36);
            ranOne = true;
        }
        assertTrue(ranOne, "deposit dirty-bits mutation not found in corpus");
    }

    /// The full wall path rejects every malicious mutation + forbidden shape on REAL
    /// encodings. Drives corpus bytes through `executeCall` with a permissive grant so
    /// only the DECODE / semantic guards can be the cause of the revert.
    function test_differential_mutationsRevertThroughWall() public {
        // fresh account with a permissive rule over `usd` for all 4 structured selectors
        _standupAccount();
        uint256 n = _count();
        uint256 rejected;
        for (uint256 i = 0; i < n; i++) {
            string memory kind = _s(i, ".kind");
            if (_eq(kind, "nonstructured")) continue;
            bool mut = _bool(i, ".mutation");
            bool forbidden = _has(i, ".forbidden");
            if (!mut && !forbidden) continue;
            bytes memory data = _bytes(i);
            vm.prank(session);
            (bool ok,) = address(acct).call(abi.encodeCall(LeashAccountV4.executeCall, (address(usd), 0, data)));
            assertFalse(ok, string.concat("mutation/forbidden should revert: ", _s(i, ".name")));
            rejected++;
        }
        assertGe(rejected, 6, "expected >=6 malicious/forbidden corpus entries");
    }

    /// The 5 canonical structured entries all PASS the wall (real encodings are legible).
    function test_differential_canonicalStructuredPassWall() public {
        _standupAccount();
        // account approves itself so transferFrom(self,...) works
        vm.prank(address(acct));
        usd.approve(address(acct), type(uint256).max);

        uint256 n = _count();
        uint256 passed;
        for (uint256 i = 0; i < n; i++) {
            if (_bool(i, ".mutation") || _has(i, ".forbidden")) continue;
            string memory kind = _s(i, ".kind");
            if (_eq(kind, "nonstructured")) continue;
            // increaseAllowance is not an OZ-v5 ERC20 function, so the shared MockERC20
            // (the live TestUSD, unmodified) reverts the external call. Its wall
            // admittance is proven separately against a token that supports it
            // (test_increaseAllowance_passesWall_countsBudget below).
            if (_eq(_s(i, ".name"), "increaseAllowance_canonical")) continue;
            // setApprovalForAll is an ERC721/1155 function, absent on the ERC20 mock;
            // its wall admittance is proven in the primary suite
            // (test_setApprovalForAll_false_operatorInSet_passesWall).
            if (_eq(kind, "setApprovalForAll")) continue;
            // deposit targets a vault (not the ERC20 mock); its wall admittance is proven in
            // the primary suite (test_flow_approveThenVaultDeposit_succeeds) + adversarial C-04.
            if (_eq(kind, "deposit")) continue;
            bytes memory data = _rewriteRecipientsToSelf(kind, _bytes(i));
            vm.prank(session);
            (bool ok, bytes memory ret) =
                address(acct).call(abi.encodeCall(LeashAccountV4.executeCall, (address(usd), 0, data)));
            assertTrue(ok, string.concat("canonical should pass: ", _s(i, ".name"), _revStr(ret)));
            passed++;
        }
        // approve + transfer + transferFrom pass here; increaseAllowance +
        // setApprovalForAll are ERC20-mock-absent and proven elsewhere (see skips above).
        assertGe(passed, 3, "expected >=3 mock-compatible canonical entries");
    }

    /// increaseAllowance through the full wall against a token that supports it:
    /// decode passes, spender∈set enforced, amount debits the cumulative budget.
    function test_increaseAllowance_passesWall_countsBudget() public {
        IncAllowanceToken tok = new IncAllowanceToken();
        address[] memory list = new address[](0);
        acct = new LeashAccountV4(
            owner,
            owner,
            session,
            LeashAccountV4.Policy({
                perTransferCap: type(uint128).max,
                windowCap: type(uint128).max,
                windowSeconds: 1 hours,
                expiresAt: type(uint64).max
            }),
            list,
            0,
            address(0),
            LeashAccountV4.TokenPolicy(0, 0)
        );
        address spender = 0x1111111111111111111111111111111111111111;
        address[] memory sp = new address[](1);
        sp[0] = spender;
        vm.startPrank(owner);
        acct.proposeSpendBudget(address(tok), 100);
        acct.applySpendBudget();
        // perCall + call-window generous; the per-token cumulative BUDGET (100) is the binding cap
        acct.proposeCallRule(address(tok), 0x39509351, 0, sp, 100, 200, bytes32(0));
        acct.applyCallRule();
        vm.stopPrank();

        bytes memory data = abi.encodeWithSelector(bytes4(0x39509351), spender, uint256(40));
        vm.prank(session);
        acct.executeCall(address(tok), 0, data);
        (, , uint128 spent,) = acct.spendBudget(address(tok));
        assertEq(spent, 40);

        // over-budget second leg reverts OverCumulativeSpend (40 + 70 > 100)
        bytes memory data2 = abi.encodeWithSelector(bytes4(0x39509351), spender, uint256(70));
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.OverCumulativeSpend.selector, 110, 100));
        acct.executeCall(address(tok), 0, data2);

        // spender off-set reverts
        bytes memory data3 = abi.encodeWithSelector(bytes4(0x39509351), address(0xBEEF), uint256(1));
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.SpenderNotAllowlisted.selector, address(0xBEEF)));
        acct.executeCall(address(tok), 0, data3);
    }

    // ---- helpers ----

    function _standupAccount() internal {
        address[] memory list = new address[](1);
        list[0] = dest;
        acct = new LeashAccountV4(
            owner,
            owner,
            session,
            LeashAccountV4.Policy({
                perTransferCap: type(uint128).max,
                windowCap: type(uint128).max,
                windowSeconds: 1 hours,
                expiresAt: type(uint64).max
            }),
            list,
            0,
            address(usd),
            LeashAccountV4.TokenPolicy(0, 0)
        );
        usd.mint(address(acct), type(uint96).max);
        // permissive spend budget + rules for all 4 structured selectors (recipientMode 0 = self)
        vm.startPrank(owner);
        acct.proposeSpendBudget(address(usd), type(uint128).max);
        acct.applySpendBudget();
        address[] memory sp = new address[](3);
        sp[0] = 0x1111111111111111111111111111111111111111;
        sp[1] = 0x2222222222222222222222222222222222222222;
        sp[2] = address(acct);
        _rule(SEL_APPROVE, 0, sp);
        _rule(0x39509351, 0, sp); // increaseAllowance
        _rule(SEL_TRANSFER, 0, sp);
        _rule(SEL_TRANSFER_FROM, 0, sp);
        _rule(SEL_SET_APPROVAL_FOR_ALL, 0, sp);
        vm.stopPrank();
    }

    function _rule(bytes4 sel, uint8 mode, address[] memory sp) internal {
        acct.proposeCallRule(address(usd), sel, mode, sp, type(uint128).max, type(uint128).max, bytes32(0));
        acct.applyCallRule();
    }

    /// The corpus recipients are stand-in addresses; for the canonical-pass test rewrite
    /// the recipient-type arg to `address(this)` (recipientMode 0 requires == self).
    function _rewriteRecipientsToSelf(string memory kind, bytes memory data) internal view returns (bytes memory) {
        bytes32 k = keccak256(bytes(kind));
        bytes32 selfWord = bytes32(uint256(uint160(address(acct))));
        if (k == keccak256("transfer")) {
            _writeWord(data, 0, selfWord); // `to` (first arg word)
        } else if (k == keccak256("transferFrom")) {
            _writeWord(data, 0, selfWord); // `from` must == self (first arg word)
            _writeWord(data, 32, selfWord); // `to` must == self (second arg word)
        }
        // approve / setApprovalForAll: spender must be in the granted set (already 0x1111)
        return data;
    }

    function _writeWord(bytes memory data, uint256 argOffset, bytes32 word) internal pure {
        // data = [selector(4)][args...]; arg word at 4 + argOffset
        uint256 p = 4 + argOffset;
        for (uint256 j = 0; j < 32; j++) {
            data[p + j] = word[j];
        }
    }

    function _addr(uint256 i, string memory field) internal view returns (address) {
        return vm.parseAddress(_s(i, field));
    }

    function _uintStr(string memory s) internal pure returns (uint256) {
        return vm.parseUint(s);
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    function _revStr(bytes memory ret) internal pure returns (string memory) {
        if (ret.length == 0) return "";
        return string.concat(" revert=", vm.toString(ret));
    }
}

/// A minimal token exposing `increaseAllowance` (removed from OZ v5) so the wall path
/// for that selector can be proven end-to-end.
contract IncAllowanceToken {
    mapping(address => mapping(address => uint256)) public allowance;

    function increaseAllowance(address spender, uint256 added) external returns (bool) {
        allowance[msg.sender][spender] += added;
        return true;
    }
}
