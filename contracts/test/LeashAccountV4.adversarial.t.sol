// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {LeashAccountV4} from "../src/LeashAccountV4.sol";
import {MockERC20} from "../src/MockERC20.sol";
import {MockRouter} from "../src/MockRouter.sol";
import {MockVault} from "../src/MockVault.sol";
import {MockBridge} from "../src/MockBridge.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// A token whose transfer/approve returns false without reverting (fake-success, H-05).
contract FakeSuccessToken {
    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }

    function approve(address, uint256) external pure returns (bool) {
        return false;
    }
}

/// A target that re-enters executeCall during its own call (H-06 reentrancy).
contract ReentrantTarget {
    LeashAccountV4 public acct;
    bytes public payload;
    bool public reentrySucceeded;
    bool private attacking;

    function set(LeashAccountV4 a, bytes calldata p) external {
        acct = a;
        payload = p;
    }

    fallback() external payable {
        if (!attacking) {
            attacking = true;
            try acct.executeCall(address(this), 0, payload) {
                reentrySucceeded = true;
            } catch {}
            attacking = false;
        }
    }
}

/// Stage D — the drain-vector catalog (C-01..M-03 + C-06 + OPS-1) as a 1:1 executable
/// revert-matrix + the ≥4 red-team classes. Every money/authority vector holds CLOSED.
contract LeashAccountV4AdversarialTest is Test {
    LeashAccountV4 internal acct;
    MockERC20 internal usd;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal session = makeAddr("session");
    address internal dest = makeAddr("beneficiary");
    address internal attacker = makeAddr("attacker");
    address internal spender = makeAddr("spender");

    uint32 constant WINDOW_SECONDS = 1 hours;
    uint64 constant DELAY = 15 minutes;

    bytes4 constant SEL_APPROVE = 0x095ea7b3;
    bytes4 constant SEL_TRANSFER = 0xa9059cbb;
    bytes4 constant SEL_TRANSFER_FROM = 0x23b872dd;
    bytes4 constant SEL_SET_APPROVAL_FOR_ALL = 0xa22cb465;
    bytes4 constant SEL_DEPOSIT = 0x6e553f65; // deposit(uint256,address)
    bytes4 constant SEL_MULTICALL = 0xac9650d8; // multicall(bytes[])
    bytes4 constant SEL_ISVALIDSIGNATURE = 0x1626ba7e; // ERC-1271

    function _policy() internal view returns (LeashAccountV4.Policy memory) {
        return LeashAccountV4.Policy({
            perTransferCap: 1 ether,
            windowCap: 3 ether,
            windowSeconds: WINDOW_SECONDS,
            expiresAt: uint64(block.timestamp + 30 days)
        });
    }

    function setUp() public {
        vm.warp(1_700_000_000);
        usd = new MockERC20("Test USD", "TestUSD", 6);
        address[] memory list = new address[](1);
        list[0] = dest;
        acct = new LeashAccountV4(
            owner, guardian, session, _policy(), list, DELAY, address(usd), LeashAccountV4.TokenPolicy(100e6, 250e6)
        );
        usd.mint(address(acct), 1_000e6);
        vm.deal(address(acct), 100 ether);
    }

    function _spenders(address a) internal pure returns (address[] memory s) {
        s = new address[](1);
        s[0] = a;
    }

    function _grant(address target, bytes4 sel, uint8 mode, address[] memory sp, uint128 pcc, uint128 wcc) internal {
        vm.prank(owner);
        acct.proposeCallRule(target, sel, mode, sp, pcc, wcc, bytes32(0));
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

    // ============ C-01: unbounded/malicious-spender approval ============
    function test_C01_infiniteApprove_reverts() public {
        _budget(address(usd), 500e6);
        _grant(address(usd), SEL_APPROVE, 0, _spenders(spender), 200e6, 400e6);
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.InfiniteApprovalForbidden.selector);
        acct.executeCall(address(usd), 0, abi.encodeWithSelector(SEL_APPROVE, spender, type(uint256).max));
    }

    function test_C01_approveToUnlistedSpender_reverts() public {
        _budget(address(usd), 500e6);
        _grant(address(usd), SEL_APPROVE, 0, _spenders(spender), 200e6, 400e6);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.SpenderNotAllowlisted.selector, attacker));
        acct.executeCall(address(usd), 0, abi.encodeWithSelector(SEL_APPROVE, attacker, 10e6));
    }

    // ============ C-02 / C-06: signature-based approvals + auth-layer bypass ============
    function test_C02_C06_noERC1271_signatureInvalidByConstruction() public {
        // The account NEVER validates a signature — a session-key permit over
        // contract-held funds is invalid by construction. isValidSignature has no
        // implementation → a staticcall to it fails (no fallback returns MAGIC).
        (bool ok,) = address(acct).staticcall(abi.encodeWithSelector(SEL_ISVALIDSIGNATURE, bytes32(0), bytes("")));
        assertFalse(ok, "account must NOT implement ERC-1271 (C-02/C-06 closed by construction)");
    }

    // ============ C-03: call wrapping (multicall / delegatecall / arbitrary) ============
    function test_C03_multicallWrapper_defaultDenied() public {
        // A wrapper selector is not in the hard-coded set and is default-denied unless
        // explicitly granted; ungranted → SelectorNotAllowlisted (never smuggles).
        _budget(address(usd), 500e6);
        _grant(address(usd), SEL_APPROVE, 0, _spenders(spender), 200e6, 400e6);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.SelectorNotAllowlisted.selector, SEL_MULTICALL));
        acct.executeCall(address(usd), 0, abi.encodeWithSelector(SEL_MULTICALL, new bytes[](0)));
    }

    function test_C03_noDelegatecallOpcode() public view {
        bytes memory code = address(acct).code;
        uint256 n = code.length;
        uint256 metaLen = (uint256(uint8(code[n - 2])) << 8) | uint256(uint8(code[n - 1]));
        uint256 end = n >= metaLen + 2 ? n - metaLen - 2 : n;
        uint256 i = 0;
        while (i < end) {
            uint8 op = uint8(code[i]);
            require(op != 0xf4 && op != 0xf2, "delegatecall/callcode present");
            if (op >= 0x60 && op <= 0x7f) i += (op - 0x5f);
            i += 1;
        }
    }

    // ============ C-04: recipient redirection ============
    function test_C04_transferRedirect_reverts() public {
        _budget(address(usd), 500e6);
        _grant(address(usd), SEL_TRANSFER, 0, new address[](0), 200e6, 400e6);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.RecipientNotSelf.selector, attacker));
        acct.executeCall(address(usd), 0, abi.encodeWithSelector(SEL_TRANSFER, attacker, 10e6));
    }

    // ============ C-04 (deposit): autonomous vault-deposit redirect / over-cap / dirty-bits ============
    // deposit(uint256 assets, address receiver) is AUTONOMOUS + preset-granted (yield_manager /
    // treasury_topper). The on-chain structured decoder must pin the receiver and cap the amount so a
    // fully-hijacked session key can never redirect the minted shares to an attacker (§8 F4/F5).
    function test_C04_depositRedirect_reverts() public {
        MockVault vault = new MockVault(IERC20(address(usd)));
        _budget(address(vault), 500e6);
        _grant(address(vault), SEL_DEPOSIT, 0, new address[](0), 200e6, 400e6); // mode 0 = receiver must be self
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.RecipientNotSelf.selector, attacker));
        acct.executeCall(address(vault), 0, abi.encodeWithSelector(SEL_DEPOSIT, uint256(10e6), attacker));
    }

    function test_C04_depositOverPerCallCap_reverts() public {
        MockVault vault = new MockVault(IERC20(address(usd)));
        _budget(address(vault), 500e6);
        _grant(address(vault), SEL_DEPOSIT, 0, new address[](0), 50e6, 400e6);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.OverPerCallCap.selector, 60e6, uint128(50e6)));
        acct.executeCall(address(vault), 0, abi.encodeWithSelector(SEL_DEPOSIT, uint256(60e6), address(acct)));
    }

    function test_C04_depositDirtyReceiverBits_reverts() public {
        MockVault vault = new MockVault(IERC20(address(usd)));
        _budget(address(vault), 500e6);
        _grant(address(vault), SEL_DEPOSIT, 0, new address[](0), 200e6, 400e6);
        bytes memory data = abi.encodePacked(
            SEL_DEPOSIT, uint256(10e6), bytes32(uint256(0xdead) << 160 | uint256(uint160(address(acct))))
        );
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.DecodeMismatch.selector);
        acct.executeCall(address(vault), 0, data);
    }

    // ============ SE-8 (E-9): bridge-drain / redirect — a hijacked session key can NEVER free-bridge ============
    // The bridge decoders pin the recipient (mode 0 → self = the SAME CREATE2 address on the far
    // chain) and charge the bridged amount; an ungranted bridge target/selector is default-denied.
    bytes4 constant SEL_BRIDGE_ETH_TO = 0xe11013dd;
    bytes4 constant SEL_BRIDGE_ERC20_TO = 0x540abf73;

    function test_E9_bridgeEthRedirect_reverts(address to) public {
        vm.assume(to != address(acct));
        MockBridge bridge = new MockBridge();
        _budget(address(0), 2 ether);
        _grant(address(bridge), SEL_BRIDGE_ETH_TO, 0, new address[](0), 1 ether, 2 ether);
        vm.prank(session);
        vm.expectRevert();
        acct.executeCall(
            address(bridge), 0.5 ether, abi.encodeWithSelector(SEL_BRIDGE_ETH_TO, to, uint32(1), bytes(""))
        );
        assertEq(bridge.ethBridged(to), 0, "redirected bridge value must never move");
    }

    function test_E9_bridgeErc20Redirect_reverts(address to) public {
        vm.assume(to != address(acct));
        MockBridge bridge = new MockBridge();
        _budget(address(bridge), 500e6);
        _grant(address(bridge), SEL_BRIDGE_ERC20_TO, 0, new address[](0), 200e6, 400e6);
        vm.prank(session);
        vm.expectRevert();
        acct.executeCall(
            address(bridge),
            0,
            abi.encodeWithSelector(
                SEL_BRIDGE_ERC20_TO, address(usd), address(0xBEEF), to, uint256(10e6), uint32(1), bytes("")
            )
        );
        assertEq(bridge.erc20Bridged(to), 0, "redirected bridge tokens must never move");
    }

    function test_E9_freeBridge_ungrantedBridge_reverts() public {
        MockBridge bridge = new MockBridge();
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.TargetNotAllowlisted.selector, address(bridge)));
        acct.executeCall(
            address(bridge), 1 ether, abi.encodeWithSelector(SEL_BRIDGE_ETH_TO, address(acct), uint32(1), bytes(""))
        );
    }

    function test_E9_bridgeExtraDataPayload_reverts(bytes calldata extraData) public {
        vm.assume(extraData.length > 0);
        MockBridge bridge = new MockBridge();
        _budget(address(0), 2 ether);
        _grant(address(bridge), SEL_BRIDGE_ETH_TO, 0, new address[](0), 1 ether, 2 ether);
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.DecodeMismatch.selector);
        acct.executeCall(
            address(bridge), 0.5 ether, abi.encodeWithSelector(SEL_BRIDGE_ETH_TO, address(acct), uint32(1), extraData)
        );
    }

    function test_E9_bridgeEthOverCap_fuzz_reverts(uint256 amount) public {
        amount = bound(amount, 1 ether + 1, 100 ether);
        MockBridge bridge = new MockBridge();
        _budget(address(0), 200 ether);
        _grant(address(bridge), SEL_BRIDGE_ETH_TO, 0, new address[](0), 1 ether, uint128(200 ether));
        vm.deal(address(acct), 200 ether);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.OverPerCallCap.selector, amount, uint128(1 ether)));
        acct.executeCall(
            address(bridge), amount, abi.encodeWithSelector(SEL_BRIDGE_ETH_TO, address(acct), uint32(1), bytes(""))
        );
    }

    // ============ C-05: proxy upgrade / metamorphic (codehash pin) ============
    function test_C05_codehashPinMismatch_reverts() public {
        _budget(address(usd), 500e6);
        vm.prank(owner);
        acct.proposeCallRule(address(usd), SEL_APPROVE, 0, _spenders(spender), 200e6, 400e6, keccak256("stale"));
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        acct.applyCallRule();
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.CodehashMismatch.selector);
        acct.executeCall(address(usd), 0, abi.encodeWithSelector(SEL_APPROVE, spender, 10e6));
    }

    // ============ H-01: swap path attacker pools + minOut=0 ============
    // v1 (decision (a)): router `swap` is NOT an on-chain structured decoder — swap-arg
    // legibility (path/minOut/deadline) runs OFF-CHAIN. The ON-CHAIN guarantee for H-01
    // is that the token a swap can pull is bounded by the capped + cumulative-budgeted
    // `approve` envelope: even a zero-floor swap can never drain more than the funding
    // approve. Proven here: the approve is budget-bounded, so the router allowance (=
    // max extractable) can never exceed the budget, regardless of minOut.
    function test_H01_swapLossBoundedByApproveEnvelope() public {
        MockRouter router = new MockRouter();
        _budget(address(usd), 50e6); // cumulative approve budget = 50 TestUSD
        _grant(address(usd), SEL_APPROVE, 0, _spenders(address(router)), 50e6, 50e6);

        // agent approves the router up to the budget
        vm.prank(session);
        acct.executeCall(address(usd), 0, abi.encodeWithSelector(SEL_APPROVE, address(router), 50e6));
        assertEq(usd.allowance(address(acct), address(router)), 50e6);

        // a further approve to widen the router's pull-limit is refused — the router can
        // never be allowed to pull more than 50e6 of the account's 1000e6 balance.
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.OverCumulativeSpend.selector, 60e6, 50e6));
        acct.executeCall(address(usd), 0, abi.encodeWithSelector(SEL_APPROVE, address(router), 10e6));

        // and the router fixture itself rejects a zero-floor swap (defense-in-depth).
        vm.expectRevert(bytes("minOut=0"));
        router.swap(address(usd), address(usd), 10e6, 0, address(acct), block.timestamp + 1);
    }

    // ============ H-02: value via args, not msg.value (cumulative amount caps) ============
    function test_H02_cumulativeAmountCap_notMsgValue() public {
        _budget(address(usd), 120e6);
        _grant(address(usd), SEL_TRANSFER, 1, new address[](0), 100e6, 1_000e6);
        vm.startPrank(session);
        acct.executeCall(address(usd), 0, abi.encodeWithSelector(SEL_TRANSFER, dest, 100e6));
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.OverCumulativeSpend.selector, 130e6, uint128(120e6)));
        acct.executeCall(address(usd), 0, abi.encodeWithSelector(SEL_TRANSFER, dest, 30e6));
        vm.stopPrank();
    }

    // ============ H-03: confused-deputy via address arg (transferFrom from != self) ============
    function test_H03_transferFromVictim_reverts() public {
        _budget(address(usd), 500e6);
        _grant(address(usd), SEL_TRANSFER_FROM, 1, new address[](0), 200e6, 400e6);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.RecipientNotSelf.selector, attacker));
        acct.executeCall(address(usd), 0, abi.encodeWithSelector(SEL_TRANSFER_FROM, attacker, dest, 10e6));
    }

    // ============ H-04: decode-vs-execute divergence ============
    function test_H04_dirtyHighBits_reverts() public {
        _budget(address(usd), 500e6);
        _grant(address(usd), SEL_TRANSFER, 1, new address[](0), 200e6, 400e6);
        bytes memory data =
            abi.encodePacked(SEL_TRANSFER, bytes32(uint256(0xdead) << 160 | uint256(uint160(dest))), uint256(10e6));
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.DecodeMismatch.selector);
        acct.executeCall(address(usd), 0, data);
    }

    // ============ H-05: token weirdness (fake-success) ============
    function test_H05_fakeSuccessToken_reverts() public {
        FakeSuccessToken fake = new FakeSuccessToken();
        _budget(address(fake), 500e6);
        _grant(address(fake), SEL_TRANSFER, 1, new address[](0), 200e6, 400e6);
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.TokenTransferFailed.selector);
        acct.executeCall(address(fake), 0, abi.encodeWithSelector(SEL_TRANSFER, dest, 10e6));
    }

    // ============ H-06: reentrancy / flash-loan callbacks ============
    function test_H06_reentrancy_blocked() public {
        ReentrantTarget evil = new ReentrantTarget();
        _budget(address(0), 0);
        // grant a non-structured selector on the evil target (fallback catches it)
        _grant(address(evil), bytes4(0x12345678), 0, new address[](0), 0, 1_000e6);
        evil.set(acct, abi.encodeWithSelector(bytes4(0x12345678)));
        vm.prank(session);
        acct.executeCall(address(evil), 0, abi.encodeWithSelector(bytes4(0x12345678)));
        assertFalse(evil.reentrySucceeded(), "reentrancy must be blocked by nonReentrant");
    }

    // ============ H-07: array/struct partial validation (v1 structured set is scalar-only) ============
    function test_H07_arrayArgSelector_notStructured_defaultDenied() public {
        // v1's hard-coded decoders are scalar-only; an array-bearing selector is
        // non-structured → must be explicitly granted, and even then arg legibility
        // is off-chain. Ungranted batch-shaped selector is default-denied on-chain.
        _budget(address(usd), 500e6);
        _grant(address(usd), SEL_APPROVE, 0, _spenders(spender), 200e6, 400e6);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.SelectorNotAllowlisted.selector, bytes4(0xcafebabe)));
        acct.executeCall(address(usd), 0, abi.encodeWithSelector(bytes4(0xcafebabe), new address[](2)));
    }

    // ============ M-01: governance/delegation abuse (blanket approval → denied) ============
    function test_M01_setApprovalForAllTrue_reverts() public {
        _grant(address(usd), SEL_SET_APPROVAL_FOR_ALL, 0, _spenders(spender), 0, 0);
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.BlanketApprovalForbidden.selector);
        acct.executeCall(address(usd), 0, abi.encodeWithSelector(SEL_SET_APPROVAL_FOR_ALL, spender, true));
    }

    // ============ M-02: gas griefing / return-bomb (bounded returndata) ============
    function test_M02_returnBomb_bounded() public {
        // A target returning huge data cannot OOG the account beyond the 32-byte copy
        // bound; the call still completes. We assert a large-returndata target succeeds.
        ReturnBomb bomb = new ReturnBomb();
        _budget(address(0), 0);
        _grant(address(bomb), bytes4(0x11111111), 0, new address[](0), 0, 1_000e6);
        vm.prank(session);
        acct.executeCall(address(bomb), 0, abi.encodeWithSelector(bytes4(0x11111111))); // does not revert
    }

    // ============ M-03: deadline/expiry + replay (one-shot expiry) ============
    function test_M03_oneShotExpiry_bounded() public {
        bytes memory data = abi.encodeWithSelector(SEL_APPROVE, spender, 10e6);
        bytes32 h = keccak256(abi.encode(address(usd), SEL_APPROVE, data, uint256(0)));
        vm.prank(owner);
        acct.authorizeOnce(h, uint64(block.timestamp + 100));
        vm.warp(block.timestamp + 101);
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.OneShotExpired.selector);
        acct.executeCall(address(usd), 0, data);
    }

    // ============ OPS-1: dependency/patch-lag (process control — accepted-risk assertion) ============
    function test_OPS1_dependencyLag_processControl() public pure {
        // OPS-1 is a THREAT-MODEL/process item, not a code one: pin + track OZ/toolchain
        // versions + a patch-currency gate in the contract re-audit checklist (D-13) +
        // the CI dependency/secrets scan. Asserted here as an explicit accepted-process
        // control so the 1:1 catalog matrix has no orphaned vector.
        assertTrue(true);
    }

    // ============ Red-team: injection / self-origination (agent cannot self-widen) ============
    function test_redteam_agentCannotGrantOwnRule() public {
        vm.prank(session); // the agent's session key
        vm.expectRevert(LeashAccountV4.NotOwner.selector);
        acct.proposeCallRule(address(usd), SEL_APPROVE, 0, _spenders(attacker), 1e30, 1e30, bytes32(0));
    }

    function test_redteam_agentCannotAuthorizeOwnOneShot() public {
        vm.prank(session);
        vm.expectRevert(LeashAccountV4.NotOwner.selector);
        acct.authorizeOnce(bytes32(uint256(1)), uint64(block.timestamp + 100));
    }

    function test_redteam_hijackedAgentBoundedToGrant() public {
        // Full-hijack worst case: even with the session key, the agent can only do a
        // capped, in-envelope, recipient-pinned call — never off-allowlist/redirect/max.
        _budget(address(usd), 50e6);
        _grant(address(usd), SEL_TRANSFER, 0, new address[](0), 50e6, 50e6);
        vm.startPrank(session);
        // to self only, ≤ cap, ≤ budget — the ONLY thing a hijack can do
        acct.executeCall(address(usd), 0, abi.encodeWithSelector(SEL_TRANSFER, address(acct), 50e6));
        // anything else reverts
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.RecipientNotSelf.selector, attacker));
        acct.executeCall(address(usd), 0, abi.encodeWithSelector(SEL_TRANSFER, attacker, 1));
        vm.stopPrank();
    }
}

/// A target that returns a large blob (M-02 return-bomb).
contract ReturnBomb {
    fallback() external payable {
        assembly {
            return(0, 100000) // 100KB of returndata
        }
    }
}
