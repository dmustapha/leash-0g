// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {LeashAccountV4} from "../src/LeashAccountV4.sol";
import {MockERC20} from "../src/MockERC20.sol";
import {MockRouter} from "../src/MockRouter.sol";
import {MockVault} from "../src/MockVault.sol";
import {MockBridge} from "../src/MockBridge.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// A token whose transfer returns false without reverting (fake-success, H-05).
contract FakeSuccessTok {
    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }
}

/// Stage D — governed-calldata wall: happy + edge + adversarial (D-1..D-7).
contract LeashAccountV4Test is Test {
    LeashAccountV4 internal acct;
    MockERC20 internal usd; // the settlement / traded token (target for structured selectors)
    MockERC20 internal tout; // a second token (swap output)
    MockRouter internal router;
    MockVault internal vault;
    MockBridge internal bridge;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal session = makeAddr("session");
    address internal dest = makeAddr("beneficiary"); // an allowlisted recipient
    address internal rando = makeAddr("rando");
    address internal spender = makeAddr("spender");

    uint128 constant PER_TX_CAP = 1 ether;
    uint128 constant WINDOW_CAP = 3 ether;
    uint32 constant WINDOW_SECONDS = 1 hours;
    uint64 constant DELAY = 15 minutes;

    bytes4 constant SEL_APPROVE = 0x095ea7b3;
    bytes4 constant SEL_TRANSFER = 0xa9059cbb;
    bytes4 constant SEL_TRANSFER_FROM = 0x23b872dd;
    bytes4 constant SEL_SET_APPROVAL_FOR_ALL = 0xa22cb465;
    bytes4 constant SEL_SWAP = MockRouter.swap.selector;
    bytes4 constant SEL_DEPOSIT = MockVault.deposit.selector;
    bytes4 constant SEL_BRIDGE_ETH_TO = MockBridge.bridgeETHTo.selector;
    bytes4 constant SEL_BRIDGE_ERC20_TO = MockBridge.bridgeERC20To.selector;

    function _policy() internal view returns (LeashAccountV4.Policy memory) {
        return LeashAccountV4.Policy({
            perTransferCap: PER_TX_CAP,
            windowCap: WINDOW_CAP,
            windowSeconds: WINDOW_SECONDS,
            expiresAt: uint64(block.timestamp + 30 days)
        });
    }

    function setUp() public {
        vm.warp(1_700_000_000);
        usd = new MockERC20("Test USD", "TestUSD", 6);
        tout = new MockERC20("Out USD", "OUT", 6);
        router = new MockRouter();
        vault = new MockVault(IERC20(address(usd)));
        bridge = new MockBridge();

        address[] memory list = new address[](1);
        list[0] = dest;
        acct = new LeashAccountV4(
            owner, guardian, session, _policy(), list, DELAY, address(usd), LeashAccountV4.TokenPolicy(100e6, 250e6)
        );
        usd.mint(address(acct), 1_000e6);
        tout.mint(address(router), 1_000e6);
        vm.deal(address(acct), 100 ether);
    }

    // ---- grant helpers ----
    function _spenders(address a) internal pure returns (address[] memory s) {
        s = new address[](1);
        s[0] = a;
    }

    function _grantRule(
        address target,
        bytes4 selector,
        uint8 recipientMode,
        address[] memory spenders,
        uint128 perCallCap,
        uint128 windowCapCall
    ) internal {
        vm.prank(owner);
        acct.proposeCallRule(target, selector, recipientMode, spenders, perCallCap, windowCapCall, bytes32(0));
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applyCallRule();
    }

    function _grantBudget(address token, uint128 cap) internal {
        vm.prank(owner);
        acct.proposeSpendBudget(token, cap);
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applySpendBudget();
    }

    function _approveData(address sp, uint256 amt) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(SEL_APPROVE, sp, amt);
    }

    function _transferData(address to, uint256 amt) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(SEL_TRANSFER, to, amt);
    }

    // ================= D-1: the wall (target/selector allowlist) =================

    function test_executeCall_allowlisted_approve_succeeds() public {
        _grantBudget(address(usd), 500e6);
        _grantRule(address(usd), SEL_APPROVE, 0, _spenders(address(router)), 200e6, 400e6);
        vm.prank(session);
        acct.executeCall(address(usd), 0, _approveData(address(router), 100e6));
        assertEq(usd.allowance(address(acct), address(router)), 100e6);
        (,,,, uint128 spent,) = acct.callRules(keccak256(abi.encodePacked(address(usd), SEL_APPROVE)));
        assertEq(spent, 100e6);
    }

    function test_executeCall_offAllowlistTarget_reverts() public {
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.TargetNotAllowlisted.selector, address(usd)));
        acct.executeCall(address(usd), 0, _approveData(address(router), 1));
    }

    function test_executeCall_offAllowlistSelector_reverts() public {
        _grantBudget(address(usd), 500e6);
        _grantRule(address(usd), SEL_APPROVE, 0, _spenders(address(router)), 200e6, 400e6);
        // transfer selector on an allowlisted target but no rule for it
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.SelectorNotAllowlisted.selector, SEL_TRANSFER));
        acct.executeCall(address(usd), 0, _transferData(dest, 1));
    }

    function test_executeCall_selfCall_reverts() public {
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.SelfCallForbidden.selector);
        acct.executeCall(address(acct), 0, _approveData(address(router), 1));
    }

    function test_executeCall_emptyCodeTarget_reverts() public {
        _grantBudget(address(usd), 500e6);
        // grant a rule for an EOA target, then call it — empty code guard fires
        _grantRule(rando, SEL_APPROVE, 0, _spenders(address(router)), 200e6, 400e6);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.EmptyCodeTarget.selector, rando));
        acct.executeCall(rando, 0, _approveData(address(router), 1));
    }

    function test_executeCall_notSessionKey_reverts() public {
        vm.prank(rando);
        vm.expectRevert(LeashAccountV4.NotSessionKey.selector);
        acct.executeCall(address(usd), 0, _approveData(address(router), 1));
    }

    function test_executeCall_afterRevoke_failsClosed() public {
        _grantBudget(address(usd), 500e6);
        _grantRule(address(usd), SEL_APPROVE, 0, _spenders(address(router)), 200e6, 400e6);
        vm.prank(guardian);
        acct.revoke();
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.AccountRevoked.selector);
        acct.executeCall(address(usd), 0, _approveData(address(router), 1));
    }

    function test_executeCall_afterExpiry_reverts() public {
        _grantBudget(address(usd), 500e6);
        _grantRule(address(usd), SEL_APPROVE, 0, _spenders(address(router)), 200e6, 400e6);
        vm.warp(block.timestamp + 31 days);
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.SessionExpired.selector);
        acct.executeCall(address(usd), 0, _approveData(address(router), 1));
    }

    function test_nativeExecute_withData_stillCalldataForbidden() public {
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.CalldataForbidden.selector);
        acct.execute(dest, 0, hex"deadbeef");
    }

    // ================= D-2: structured decoders =================

    function test_approveMax_reverts_infiniteApproval() public {
        _grantBudget(address(usd), 500e6);
        _grantRule(address(usd), SEL_APPROVE, 0, _spenders(address(router)), 500e6, 500e6);
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.InfiniteApprovalForbidden.selector);
        acct.executeCall(address(usd), 0, _approveData(address(router), type(uint256).max));
    }

    function test_approve_spenderNotInSet_reverts() public {
        _grantBudget(address(usd), 500e6);
        _grantRule(address(usd), SEL_APPROVE, 0, _spenders(address(router)), 200e6, 400e6);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.SpenderNotAllowlisted.selector, rando));
        acct.executeCall(address(usd), 0, _approveData(rando, 100e6));
    }

    function test_transfer_recipientSelf_succeeds() public {
        _grantBudget(address(usd), 500e6);
        _grantRule(address(usd), SEL_TRANSFER, 0, new address[](0), 200e6, 400e6);
        vm.prank(session);
        acct.executeCall(address(usd), 0, _transferData(address(acct), 50e6)); // self
    }

    function test_transfer_recipientNotSelf_reverts_mode0() public {
        _grantBudget(address(usd), 500e6);
        _grantRule(address(usd), SEL_TRANSFER, 0, new address[](0), 200e6, 400e6);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.RecipientNotSelf.selector, rando));
        acct.executeCall(address(usd), 0, _transferData(rando, 10e6));
    }

    function test_transfer_recipientAllowlisted_mode1_succeeds() public {
        _grantBudget(address(usd), 500e6);
        _grantRule(address(usd), SEL_TRANSFER, 1, new address[](0), 200e6, 400e6);
        vm.prank(session);
        acct.executeCall(address(usd), 0, _transferData(dest, 30e6)); // dest is allowlisted
        assertEq(usd.balanceOf(dest), 30e6);
    }

    function test_transfer_recipientOffAllowlist_mode1_reverts() public {
        _grantBudget(address(usd), 500e6);
        _grantRule(address(usd), SEL_TRANSFER, 1, new address[](0), 200e6, 400e6);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.NotAllowlisted.selector, rando));
        acct.executeCall(address(usd), 0, _transferData(rando, 10e6));
    }

    function test_transferFrom_fromNotSelf_reverts() public {
        _grantBudget(address(usd), 500e6);
        _grantRule(address(usd), SEL_TRANSFER_FROM, 1, new address[](0), 200e6, 400e6);
        bytes memory data = abi.encodeWithSelector(SEL_TRANSFER_FROM, rando, dest, 10e6);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.RecipientNotSelf.selector, rando));
        acct.executeCall(address(usd), 0, data);
    }

    function test_setApprovalForAll_true_reverts_blanket() public {
        _grantRule(address(usd), SEL_SET_APPROVAL_FOR_ALL, 0, _spenders(address(router)), 0, 0);
        bytes memory data = abi.encodeWithSelector(SEL_SET_APPROVAL_FOR_ALL, address(router), true);
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.BlanketApprovalForbidden.selector);
        acct.executeCall(address(usd), 0, data);
    }

    function test_setApprovalForAll_false_operatorInSet_passesWall() public {
        // approved==false + operator∈set clears the wall's decoder; MockERC20 (an
        // ERC-20) has no setApprovalForAll, so the target itself reverts → CallFailed.
        // The CallFailed (not a wall error) proves the DECODER let the safe shape through.
        _grantRule(address(usd), SEL_SET_APPROVAL_FOR_ALL, 0, _spenders(address(router)), 0, 0);
        bytes memory data = abi.encodeWithSelector(SEL_SET_APPROVAL_FOR_ALL, address(router), false);
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.CallFailed.selector);
        acct.executeCall(address(usd), 0, data);
    }

    // H-04: strict canonical decode — dirty high bits in an address word.
    function test_decode_dirtyHighBitsAddress_reverts_decodeMismatch() public {
        _grantBudget(address(usd), 500e6);
        _grantRule(address(usd), SEL_TRANSFER, 1, new address[](0), 200e6, 400e6);
        // build transfer(to, amount) but pollute the upper bits of the `to` word
        bytes memory data =
            abi.encodePacked(SEL_TRANSFER, bytes32(uint256(1) << 200 | uint256(uint160(dest))), uint256(10e6));
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.DecodeMismatch.selector);
        acct.executeCall(address(usd), 0, data);
    }

    // H-04: wrong calldata length (trailing bytes) → DecodeMismatch.
    function test_decode_trailingBytes_reverts_decodeMismatch() public {
        _grantBudget(address(usd), 500e6);
        _grantRule(address(usd), SEL_TRANSFER, 1, new address[](0), 200e6, 400e6);
        bytes memory data = abi.encodePacked(_transferData(dest, 10e6), hex"00"); // 1 trailing byte
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.DecodeMismatch.selector);
        acct.executeCall(address(usd), 0, data);
    }

    function test_setApprovalForAll_nonCanonicalBool_reverts() public {
        _grantRule(address(usd), SEL_SET_APPROVAL_FOR_ALL, 0, _spenders(address(router)), 0, 0);
        bytes memory data = abi.encodePacked(SEL_SET_APPROVAL_FOR_ALL, uint256(uint160(address(router))), uint256(2));
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.DecodeMismatch.selector);
        acct.executeCall(address(usd), 0, data);
    }

    // ================= D-3: multi-leg cumulative outflow budget (the spine) =================

    function test_cumulativeBudget_subCapLegsAggregate_revert() public {
        _grantBudget(address(usd), 150e6); // per-token budget across ALL legs
        _grantRule(address(usd), SEL_APPROVE, 0, _spenders(address(router)), 100e6, 1_000e6);
        _grantRule(address(usd), SEL_TRANSFER, 1, new address[](0), 100e6, 1_000e6);
        vm.startPrank(session);
        acct.executeCall(address(usd), 0, _approveData(address(router), 100e6)); // budget: 100
        // a second sub-cap leg of 60 would make 160 > 150 budget → revert
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.OverCumulativeSpend.selector, 160e6, uint128(150e6)));
        acct.executeCall(address(usd), 0, _transferData(dest, 60e6));
        vm.stopPrank();
    }

    function test_cumulativeBudget_approveAndTransfer_shareOneBudget() public {
        _grantBudget(address(usd), 200e6);
        _grantRule(address(usd), SEL_APPROVE, 0, _spenders(address(router)), 200e6, 1_000e6);
        _grantRule(address(usd), SEL_TRANSFER, 1, new address[](0), 200e6, 1_000e6);
        vm.startPrank(session);
        acct.executeCall(address(usd), 0, _approveData(address(router), 120e6));
        acct.executeCall(address(usd), 0, _transferData(dest, 80e6)); // 120+80 = 200 exactly
        (, uint128 cap, uint128 spent,) = acct.spendBudget(address(usd));
        assertEq(spent, 200e6);
        assertEq(cap, 200e6);
        vm.stopPrank();
    }

    function test_budget_notSet_reverts() public {
        _grantRule(address(usd), SEL_TRANSFER, 1, new address[](0), 200e6, 400e6);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.BudgetNotSet.selector, address(usd)));
        acct.executeCall(address(usd), 0, _transferData(dest, 10e6));
    }

    function test_budget_windowRollover_resets() public {
        _grantBudget(address(usd), 150e6);
        _grantRule(address(usd), SEL_TRANSFER, 1, new address[](0), 150e6, 1_000e6);
        vm.startPrank(session);
        acct.executeCall(address(usd), 0, _transferData(dest, 150e6));
        vm.warp(block.timestamp + WINDOW_SECONDS);
        acct.executeCall(address(usd), 0, _transferData(dest, 100e6)); // window reset
        (,, uint128 spent,) = acct.spendBudget(address(usd));
        assertEq(spent, 100e6);
        vm.stopPrank();
    }

    // ================= D-2/D-4: per-call cap + window cap =================

    function test_overPerCallCap_reverts() public {
        _grantBudget(address(usd), 1_000e6);
        _grantRule(address(usd), SEL_TRANSFER, 1, new address[](0), 50e6, 1_000e6);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.OverPerCallCap.selector, 60e6, uint128(50e6)));
        acct.executeCall(address(usd), 0, _transferData(dest, 60e6));
    }

    function test_overCallWindowCap_reverts() public {
        _grantBudget(address(usd), 1_000e6);
        _grantRule(address(usd), SEL_TRANSFER, 1, new address[](0), 100e6, 150e6);
        vm.startPrank(session);
        acct.executeCall(address(usd), 0, _transferData(dest, 100e6));
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.OverCallWindowCap.selector, 160e6, uint128(150e6)));
        acct.executeCall(address(usd), 0, _transferData(dest, 60e6));
        vm.stopPrank();
    }

    // ================= realistic flows: approve → swap / deposit =================

    function test_flow_approveThenSwap_succeeds() public {
        _grantBudget(address(usd), 500e6);
        _grantRule(address(usd), SEL_APPROVE, 0, _spenders(address(router)), 200e6, 1_000e6);
        // swap is a non-structured allowlisted selector (native-value budget, value 0)
        _grantBudget(address(0), 0); // native budget set to 0 (no value calls)
        _grantRule(address(router), SEL_SWAP, 0, new address[](0), 0, 1_000e6);
        vm.startPrank(session);
        acct.executeCall(address(usd), 0, _approveData(address(router), 100e6));
        bytes memory swapData = abi.encodeWithSelector(
            SEL_SWAP, address(usd), address(tout), uint256(100e6), uint256(90e6), address(acct), block.timestamp + 100
        );
        acct.executeCall(address(router), 0, swapData);
        vm.stopPrank();
        assertEq(tout.balanceOf(address(acct)), 100e6);
    }

    function test_flow_approveThenVaultDeposit_succeeds() public {
        _grantBudget(address(usd), 500e6);
        _grantRule(address(usd), SEL_APPROVE, 0, _spenders(address(vault)), 200e6, 1_000e6);
        // deposit is now a structured selector: pin receiver==self (mode 0), charge
        // `assets` against a per-call cap + the vault-keyed cumulative budget.
        _grantBudget(address(vault), 500e6);
        _grantRule(address(vault), SEL_DEPOSIT, 0, new address[](0), 200e6, 1_000e6);
        vm.startPrank(session);
        acct.executeCall(address(usd), 0, _approveData(address(vault), 100e6));
        bytes memory depData = abi.encodeWithSelector(SEL_DEPOSIT, uint256(100e6), address(acct));
        acct.executeCall(address(vault), 0, depData);
        vm.stopPrank();
        assertEq(vault.shares(address(acct)), 100e6);
    }

    // ================= SE-8 (E-9): governed bridging — OP-stack bridge decoders =================

    function _bridgeEthData(address to) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(SEL_BRIDGE_ETH_TO, to, uint32(200_000), bytes(""));
    }

    function _bridgeErc20Data(address localTok, address to, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(
            SEL_BRIDGE_ERC20_TO, localTok, address(0xBEEF), to, amount, uint32(200_000), bytes("")
        );
    }

    function _grantEthBridge(uint128 perCall, uint128 nativeBudget) internal {
        _grantBudget(address(0), nativeBudget);
        _grantRule(address(bridge), SEL_BRIDGE_ETH_TO, 0, new address[](0), perCall, nativeBudget);
    }

    function _grantErc20Bridge(uint128 perCall, uint128 bridgeBudget) internal {
        _grantBudget(address(bridge), bridgeBudget);
        _grantRule(address(bridge), SEL_BRIDGE_ERC20_TO, 0, new address[](0), perCall, bridgeBudget);
    }

    function test_bridgeEthTo_self_inCap_lands() public {
        _grantEthBridge(1 ether, 2 ether);
        vm.prank(session);
        acct.executeCall(address(bridge), 0.5 ether, _bridgeEthData(address(acct)));
        // recipient pinned to the SAME CREATE2 address (self) — far-chain funds stay leashed
        assertEq(bridge.ethBridged(address(acct)), 0.5 ether);
        (,, uint128 spent,) = acct.spendBudget(address(0));
        assertEq(spent, 0.5 ether);
    }

    function test_bridgeEthTo_redirect_reverts_recipientNotSelf() public {
        _grantEthBridge(1 ether, 2 ether);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.RecipientNotSelf.selector, rando));
        acct.executeCall(address(bridge), 0.5 ether, _bridgeEthData(rando));
    }

    function test_bridgeEthTo_overPerCallCap_reverts() public {
        _grantEthBridge(1 ether, 5 ether);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.OverPerCallCap.selector, 2 ether, uint128(1 ether)));
        acct.executeCall(address(bridge), 2 ether, _bridgeEthData(address(acct)));
    }

    function test_bridgeEthTo_offAllowlistBridge_reverts() public {
        // no rule/target grant at all → the wall refuses the bridge target itself
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.TargetNotAllowlisted.selector, address(bridge)));
        acct.executeCall(address(bridge), 0.5 ether, _bridgeEthData(address(acct)));
    }

    function test_bridgeEthTo_nonEmptyExtraData_reverts_decodeMismatch() public {
        _grantEthBridge(1 ether, 2 ether);
        bytes memory data =
            abi.encodeWithSelector(SEL_BRIDGE_ETH_TO, address(acct), uint32(200_000), bytes(hex"deadbeef"));
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.DecodeMismatch.selector);
        acct.executeCall(address(bridge), 0.5 ether, data);
    }

    function test_bridgeEthTo_dirtyRecipientBits_reverts() public {
        _grantEthBridge(1 ether, 2 ether);
        bytes memory data = abi.encodePacked(
            SEL_BRIDGE_ETH_TO,
            bytes32(uint256(uint160(address(acct))) | (uint256(1) << 160)), // dirty upper bits
            bytes32(uint256(200_000)),
            bytes32(uint256(0x60)),
            bytes32(0)
        );
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.DecodeMismatch.selector);
        acct.executeCall(address(bridge), 0.5 ether, data);
    }

    function test_bridgeEthTo_nonCanonicalOffset_reverts() public {
        _grantEthBridge(1 ether, 2 ether);
        bytes memory data = abi.encodePacked(
            SEL_BRIDGE_ETH_TO,
            bytes32(uint256(uint160(address(acct)))),
            bytes32(uint256(200_000)),
            bytes32(uint256(0x80)), // non-canonical head offset
            bytes32(0),
            bytes32(0)
        );
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.DecodeMismatch.selector);
        acct.executeCall(address(bridge), 0.5 ether, data);
    }

    function test_bridgeErc20To_self_inCap_lands_andChargesBridgeBudget() public {
        _grantBudget(address(usd), 500e6);
        _grantRule(address(usd), SEL_APPROVE, 0, _spenders(address(bridge)), 200e6, 1_000e6);
        _grantErc20Bridge(200e6, 400e6);
        vm.startPrank(session);
        acct.executeCall(address(usd), 0, _approveData(address(bridge), 100e6));
        acct.executeCall(address(bridge), 0, _bridgeErc20Data(address(usd), address(acct), 100e6));
        vm.stopPrank();
        assertEq(bridge.erc20Bridged(address(acct)), 100e6);
        (,, uint128 spent,) = acct.spendBudget(address(bridge));
        assertEq(spent, 100e6);
    }

    function test_bridgeErc20To_redirect_reverts_recipientNotSelf() public {
        _grantErc20Bridge(200e6, 400e6);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.RecipientNotSelf.selector, rando));
        acct.executeCall(address(bridge), 0, _bridgeErc20Data(address(usd), rando, 100e6));
    }

    function test_bridgeErc20To_overPerCallCap_reverts() public {
        _grantErc20Bridge(200e6, 400e6);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.OverPerCallCap.selector, 300e6, uint128(200e6)));
        acct.executeCall(address(bridge), 0, _bridgeErc20Data(address(usd), address(acct), 300e6));
    }

    function test_bridgeErc20To_overCumulativeBudget_reverts() public {
        _grantBudget(address(usd), 500e6);
        _grantRule(address(usd), SEL_APPROVE, 0, _spenders(address(bridge)), 200e6, 1_000e6);
        _grantErc20Bridge(200e6, 300e6);
        vm.startPrank(session);
        acct.executeCall(address(usd), 0, _approveData(address(bridge), 200e6));
        acct.executeCall(address(bridge), 0, _bridgeErc20Data(address(usd), address(acct), 200e6));
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.OverCumulativeSpend.selector, 400e6, uint128(300e6)));
        acct.executeCall(address(bridge), 0, _bridgeErc20Data(address(usd), address(acct), 200e6));
        vm.stopPrank();
    }

    function test_bridgeErc20To_valueRides_reverts_decodeMismatch() public {
        _grantErc20Bridge(200e6, 400e6);
        // nonpayable canonical: msg.value may never ride uncharged on the ERC-20 leg
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.DecodeMismatch.selector);
        acct.executeCall(address(bridge), 1 wei, _bridgeErc20Data(address(usd), address(acct), 100e6));
    }

    function test_bridgeErc20To_nonEmptyExtraData_reverts_decodeMismatch() public {
        _grantErc20Bridge(200e6, 400e6);
        bytes memory data = abi.encodeWithSelector(
            SEL_BRIDGE_ERC20_TO, address(usd), address(0xBEEF), address(acct), uint256(100e6), uint32(200_000),
            bytes(hex"01")
        );
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.DecodeMismatch.selector);
        acct.executeCall(address(bridge), 0, data);
    }

    function test_bridgeErc20To_dirtyMinGasBits_reverts() public {
        _grantErc20Bridge(200e6, 400e6);
        bytes memory data = abi.encodePacked(
            SEL_BRIDGE_ERC20_TO,
            bytes32(uint256(uint160(address(usd)))),
            bytes32(uint256(uint160(address(0xBEEF)))),
            bytes32(uint256(uint160(address(acct)))),
            bytes32(uint256(100e6)),
            bytes32(uint256(200_000) | (uint256(1) << 32)), // dirty bits above uint32
            bytes32(uint256(0xc0)),
            bytes32(0)
        );
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.DecodeMismatch.selector);
        acct.executeCall(address(bridge), 0, data);
    }

    function test_bridgeEthTo_allowlistMode_permitsAllowlistedRecipient() public {
        // recipientMode=1: an owner may deliberately allow a non-self allowlisted recipient
        _grantBudget(address(0), 2 ether);
        _grantRule(address(bridge), SEL_BRIDGE_ETH_TO, 1, new address[](0), 1 ether, 2 ether);
        vm.prank(session);
        acct.executeCall(address(bridge), 0.25 ether, _bridgeEthData(dest));
        assertEq(bridge.ethBridged(dest), 0.25 ether);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.NotAllowlisted.selector, rando));
        acct.executeCall(address(bridge), 0.25 ether, _bridgeEthData(rando));
    }

    // ================= D-6: grant timelock (loosen-timelocked / tighten-instant) =================

    function test_applyCallRule_beforeEta_reverts() public {
        address[] memory s = _spenders(address(router));
        vm.prank(owner);
        acct.proposeCallRule(address(usd), SEL_APPROVE, 0, s, 200e6, 400e6, bytes32(0));
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(LeashAccountV4.TimelockNotElapsed.selector, uint64(block.timestamp) + DELAY)
        );
        acct.applyCallRule();
    }

    function test_tightenCallRule_instant_lowerOnly() public {
        _grantRule(address(usd), SEL_TRANSFER, 1, new address[](0), 100e6, 400e6);
        vm.prank(owner);
        acct.tightenCallRule(address(usd), SEL_TRANSFER, 50e6, 200e6);
        (,, uint128 pcc, uint128 wcc,,) = acct.callRules(keccak256(abi.encodePacked(address(usd), SEL_TRANSFER)));
        assertEq(pcc, 50e6);
        assertEq(wcc, 200e6);
    }

    function test_tightenCallRule_raise_reverts_notTightening() public {
        _grantRule(address(usd), SEL_TRANSFER, 1, new address[](0), 100e6, 400e6);
        vm.prank(owner);
        vm.expectRevert(LeashAccountV4.NotTightening.selector);
        acct.tightenCallRule(address(usd), SEL_TRANSFER, 200e6, 400e6);
    }

    function test_revoke_clearsPendingCallRule() public {
        address[] memory s = _spenders(address(router));
        vm.prank(owner);
        acct.proposeCallRule(address(usd), SEL_APPROVE, 0, s, 200e6, 400e6, bytes32(0));
        vm.prank(guardian);
        acct.revoke();
        (,,,,,, uint64 eta) = acct.pendingCallRule();
        assertEq(eta, 0);
    }

    function test_removeCallSelector_thenCallReverts() public {
        _grantBudget(address(usd), 500e6);
        _grantRule(address(usd), SEL_TRANSFER, 1, new address[](0), 100e6, 400e6);
        vm.prank(owner);
        acct.removeCallSelector(address(usd), SEL_TRANSFER);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.SelectorNotAllowlisted.selector, SEL_TRANSFER));
        acct.executeCall(address(usd), 0, _transferData(dest, 10e6));
    }

    function test_removeCallTarget_thenCallReverts() public {
        _grantBudget(address(usd), 500e6);
        _grantRule(address(usd), SEL_TRANSFER, 1, new address[](0), 100e6, 400e6);
        vm.prank(owner);
        acct.removeCallTarget(address(usd));
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.TargetNotAllowlisted.selector, address(usd)));
        acct.executeCall(address(usd), 0, _transferData(dest, 10e6));
    }

    function test_spendBudget_applyBeforeEta_reverts() public {
        vm.prank(owner);
        acct.proposeSpendBudget(address(usd), 500e6);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(LeashAccountV4.TimelockNotElapsed.selector, uint64(block.timestamp) + DELAY)
        );
        acct.applySpendBudget();
    }

    function test_tightenSpendBudget_raise_reverts() public {
        _grantBudget(address(usd), 500e6);
        vm.prank(owner);
        vm.expectRevert(LeashAccountV4.NotTightening.selector);
        acct.tightenSpendBudget(address(usd), 600e6);
    }

    function test_grantOps_onlyOwner() public {
        vm.prank(rando);
        vm.expectRevert(LeashAccountV4.NotOwner.selector);
        acct.proposeCallRule(address(usd), SEL_APPROVE, 0, new address[](0), 1, 1, bytes32(0));
    }

    // ================= D-7: one-shot JIT (approve-once) =================

    function _callHash(address target, bytes memory data, uint256 value) internal pure returns (bytes32) {
        return keccak256(abi.encode(target, bytes4(data), data, value));
    }

    function test_oneShot_exactCall_succeedsOnce_thenReverts() public {
        // NO standing rule: a novel target/selector authorized once by the owner.
        bytes memory data = _approveData(address(router), 100e6);
        bytes32 h = _callHash(address(usd), data, 0);
        vm.prank(owner);
        acct.authorizeOnce(h, uint64(block.timestamp + 1 hours));
        vm.prank(session);
        acct.executeCall(address(usd), 0, data); // consumes the one-shot
        assertEq(usd.allowance(address(acct), address(router)), 100e6);
        // replay → the one-shot is consumed → falls through to standing wall → TargetNotAllowlisted
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.TargetNotAllowlisted.selector, address(usd)));
        acct.executeCall(address(usd), 0, data);
    }

    function test_oneShot_differentCall_notAuthorized_reverts() public {
        bytes memory data = _approveData(address(router), 100e6);
        bytes32 h = _callHash(address(usd), data, 0);
        vm.prank(owner);
        acct.authorizeOnce(h, uint64(block.timestamp + 1 hours));
        // a different amount → different hash → not authorized → standing wall rejects
        bytes memory other = _approveData(address(router), 101e6);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.TargetNotAllowlisted.selector, address(usd)));
        acct.executeCall(address(usd), 0, other);
    }

    function test_oneShot_expired_reverts() public {
        bytes memory data = _approveData(address(router), 100e6);
        bytes32 h = _callHash(address(usd), data, 0);
        vm.prank(owner);
        acct.authorizeOnce(h, uint64(block.timestamp + 100));
        vm.warp(block.timestamp + 101);
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.OneShotExpired.selector);
        acct.executeCall(address(usd), 0, data);
    }

    function test_authorizeOnce_pastExpiry_reverts() public {
        vm.prank(owner);
        vm.expectRevert(LeashAccountV4.OneShotExpired.selector);
        acct.authorizeOnce(bytes32(uint256(1)), uint64(block.timestamp));
    }

    function test_authorizeOnce_onlyOwner() public {
        vm.prank(rando);
        vm.expectRevert(LeashAccountV4.NotOwner.selector);
        acct.authorizeOnce(bytes32(uint256(1)), uint64(block.timestamp + 100));
    }

    // H-01 fix: the one-shot path must ALSO enforce the SafeERC20 bool-check (H-05).
    function test_oneShot_fakeSuccessToken_reverts() public {
        FakeSuccessTok fake = new FakeSuccessTok();
        bytes memory data = _transferData(dest, 10e6);
        bytes32 h = _callHash(address(fake), data, 0);
        vm.prank(owner);
        acct.authorizeOnce(h, uint64(block.timestamp + 1 hours));
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.TokenTransferFailed.selector);
        acct.executeCall(address(fake), 0, data);
    }

    // M-01 stated invariant: a one-shot is OUTSIDE the cumulative per-token budget
    // (owner-signed exact call, additive to the standing budget) — documented + pinned.
    function test_oneShot_doesNotDebitStandingBudget() public {
        _grantBudget(address(usd), 100e6);
        _grantRule(address(usd), SEL_APPROVE, 0, _spenders(address(router)), 100e6, 400e6);
        // consume the FULL standing budget via a normal call
        vm.prank(session);
        acct.executeCall(address(usd), 0, _approveData(address(router), 100e6));
        (,, uint128 spentBefore,) = acct.spendBudget(address(usd));
        assertEq(spentBefore, 100e6);
        // a one-shot transfer still executes (budget exhausted) — it's outside the budget
        bytes memory data = _transferData(address(acct), 50e6);
        bytes32 h = _callHash(address(usd), data, 0);
        vm.prank(owner);
        acct.authorizeOnce(h, uint64(block.timestamp + 1 hours));
        vm.prank(session);
        acct.executeCall(address(usd), 0, data);
        (,, uint128 spentAfter,) = acct.spendBudget(address(usd));
        assertEq(spentAfter, 100e6, "one-shot must NOT debit the standing budget");
    }

    // L-02 fix: a removal (tightening) clears matured/pending loosenings.
    function test_removeCallSelector_clearsPending() public {
        _grantRule(address(usd), SEL_TRANSFER, 1, new address[](0), 100e6, 400e6);
        vm.startPrank(owner);
        acct.proposeSpendBudget(address(usd), 999e6); // a pending loosening
        acct.removeCallSelector(address(usd), SEL_TRANSFER);
        vm.stopPrank();
        assertEq(acct.pendingBudgetEta(), 0, "removal must clear the pending budget loosening");
    }

    // ================= C-05: codehash pin =================

    function test_codehashPin_mismatch_reverts() public {
        _grantBudget(address(usd), 500e6);
        address[] memory s = _spenders(address(router));
        vm.prank(owner);
        acct.proposeCallRule(address(usd), SEL_APPROVE, 0, s, 200e6, 400e6, keccak256("wrong-codehash"));
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applyCallRule();
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.CodehashMismatch.selector);
        acct.executeCall(address(usd), 0, _approveData(address(router), 10e6));
    }

    function test_codehashPin_match_succeeds() public {
        _grantBudget(address(usd), 500e6);
        address[] memory s = _spenders(address(router));
        vm.prank(owner);
        acct.proposeCallRule(address(usd), SEL_APPROVE, 0, s, 200e6, 400e6, address(usd).codehash);
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applyCallRule();
        vm.prank(session);
        acct.executeCall(address(usd), 0, _approveData(address(router), 10e6));
    }

    // ================= substrate interaction (v3 paths + new pending-slot clears) =================

    function test_substrate_nativeExecute_stillWorks() public {
        vm.prank(session);
        acct.execute(dest, 1 ether, "");
        assertEq(dest.balance, 1 ether);
        assertEq(acct.spentInWindow(), 1 ether);
    }

    function test_substrate_executeTokenTransfer_stillWorks() public {
        vm.prank(session);
        acct.executeTokenTransfer(address(usd), dest, 40e6);
        assertEq(usd.balanceOf(dest), 40e6);
        assertEq(acct.spentInWindowToken(), 40e6);
    }

    function test_revoke_clearsAllPendingSlots_inclBudgetAndCallRule() public {
        vm.startPrank(owner);
        acct.proposeCallRule(address(usd), SEL_APPROVE, 0, _spenders(address(router)), 1, 1, bytes32(0));
        acct.proposeSpendBudget(address(usd), 500e6);
        acct.proposePolicy(
            LeashAccountV4.Policy(PER_TX_CAP + 1, WINDOW_CAP, WINDOW_SECONDS, uint64(block.timestamp + 60 days))
        );
        vm.stopPrank();
        vm.prank(guardian);
        acct.revoke();
        (,,,,,, uint64 crEta) = acct.pendingCallRule();
        assertEq(crEta, 0);
        assertEq(acct.pendingBudgetEta(), 0);
        assertEq(acct.pendingPolicyEta(), 0);
    }

    function test_tightenPolicy_clearsCallRuleAndBudgetSlots() public {
        vm.startPrank(owner);
        acct.proposeCallRule(address(usd), SEL_APPROVE, 0, _spenders(address(router)), 1, 1, bytes32(0));
        acct.proposeSpendBudget(address(usd), 500e6);
        // an instant tighten of the native policy must clear the new pending slots too
        acct.tightenPolicy(
            LeashAccountV4.Policy(PER_TX_CAP - 1, WINDOW_CAP - 1, WINDOW_SECONDS, uint64(block.timestamp + 1))
        );
        vm.stopPrank();
        (,,,,,, uint64 crEta) = acct.pendingCallRule();
        assertEq(crEta, 0);
        assertEq(acct.pendingBudgetEta(), 0);
    }

    function test_applySpendBudget_thenTightenInstant() public {
        _grantBudget(address(usd), 500e6);
        (bool set, uint128 cap,,) = acct.spendBudget(address(usd));
        assertTrue(set);
        assertEq(cap, 500e6);
        vm.prank(owner);
        acct.tightenSpendBudget(address(usd), 100e6);
        (, uint128 cap2,,) = acct.spendBudget(address(usd));
        assertEq(cap2, 100e6);
    }

    // ================= D-5: no delegatecall reachable (bytecode assertion) =================

    function test_noDelegatecall_opcodeAbsent() public view {
        // executeCall uses only `.call`. Assert the deployed runtime bytecode contains
        // no DELEGATECALL (0xf4) or CALLCODE (0xf2) OPCODE — a PUSH-aware disassembly
        // walk (skipping PUSH immediates + the trailing CBOR metadata, which are DATA,
        // not code). Arbitrary-code-against-own-storage is impossible by construction
        // (D-5 / C-03).
        bytes memory code = address(acct).code;
        uint256 n = code.length;
        require(n > 2, "no code");
        // strip CBOR metadata: last 2 bytes = big-endian metadata length.
        uint256 metaLen = (uint256(uint8(code[n - 2])) << 8) | uint256(uint8(code[n - 1]));
        uint256 end = n >= metaLen + 2 ? n - metaLen - 2 : n;
        uint256 i = 0;
        while (i < end) {
            uint8 op = uint8(code[i]);
            require(op != 0xf4, "DELEGATECALL opcode present");
            require(op != 0xf2, "CALLCODE opcode present");
            if (op >= 0x60 && op <= 0x7f) {
                // PUSH1..PUSH32 — skip the (op-0x5f) immediate data bytes.
                i += (op - 0x5f);
            }
            i += 1;
        }
    }
}
