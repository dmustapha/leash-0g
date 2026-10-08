// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Vm} from "forge-std/Vm.sol";
import {LeashAccountV5} from "../src/LeashAccountV5.sol";
import {DecodeLib} from "../src/DecodeLib.sol";
import {SigningLib} from "../src/SigningLib.sol";
import {MockERC20} from "../src/MockERC20.sol";

/// Fuzzes valid-signature signing-intent arming + re-arming + time warps against the wall.
/// Each arm produces a real session-key ECDSA signature, so only genuinely-authorized
/// intents are attempted. The budget window is set non-resetting (policy windowSeconds =
/// 3650 days) so the per-token `spent` is MONOTONIC across the run — which lets the
/// invariant assert an EXACT accounting identity (`spent == Σ debited`) rather than a
/// vacuous bound. That identity is mutation-sensitive: delete `_debitSpendBudget` and
/// `spent` stays 0 while the ghost sum grows → the invariant fails. A second invariant
/// catches a deleted re-arm idempotency guard.
contract SigningHandler is Test {
    LeashAccountV5 public acct;
    address public session;
    uint256 internal sessionPk;
    address public token;
    uint256 public descriptorId;
    bytes32 internal domainSep;
    bytes32 internal typeHash;
    address internal spender;
    uint128 public perIntentCap;
    uint64 public maxWindow;

    bytes4 constant ERC1271_MAGIC = 0x1626ba7e;

    uint256 public armedCount;
    uint256 public armFailures;
    uint256 public rearmCount;
    /// @notice Set true iff a re-arm of a STILL-LIVE digest ever succeeded — i.e. the
    ///         `AlreadyArmed` idempotency guard was defeated (double-debit). Must stay false.
    bool public rearmGuardBroken;
    /// @notice Σ of the notional actually debited by successful arms — the ghost mirror of
    ///         `spendBudget.spent` (budget window never resets, so this is exact).
    uint256 public ghostDebited;

    // last successful arm, for the re-arm handler
    bool internal hasLast;
    bytes32[] internal lastFields;
    bytes32 internal lastDigest;
    uint256 internal lastAmount;

    constructor(
        LeashAccountV5 _acct,
        address _session,
        uint256 _sessionPk,
        address _token,
        uint256 _descriptorId,
        bytes32 _domainSep,
        bytes32 _typeHash,
        address _spender,
        uint128 _perIntentCap,
        uint64 _maxWindow
    ) {
        acct = _acct;
        session = _session;
        sessionPk = _sessionPk;
        token = _token;
        descriptorId = _descriptorId;
        domainSep = _domainSep;
        typeHash = _typeHash;
        spender = _spender;
        perIntentCap = _perIntentCap;
        maxWindow = _maxWindow;
    }

    function _mkFields(uint256 amount, uint256 deadline, uint256 nonce) internal view returns (bytes32[] memory f) {
        f = new bytes32[](5);
        f[0] = bytes32(uint256(uint160(spender))); // owner field (unused role)
        f[1] = bytes32(uint256(uint160(spender)));
        f[2] = bytes32(amount);
        f[3] = bytes32(nonce);
        f[4] = bytes32(deadline);
    }

    function _digest(bytes32[] memory f) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", domainSep, keccak256(abi.encodePacked(typeHash, f))));
    }

    function doArm(uint256 amount, uint256 dOffset, uint256 nonce) external {
        amount = bound(amount, 0, uint256(perIntentCap));
        dOffset = bound(dOffset, 1, uint256(maxWindow));
        uint256 deadline = block.timestamp + dOffset;
        bytes32[] memory f = _mkFields(amount, deadline, nonce);
        bytes32 digest = _digest(f);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sessionPk, digest);
        vm.prank(session);
        try acct.authorizeSigningIntent(descriptorId, f, new SigningLib.TokenCap[](0), abi.encodePacked(r, s, v), "") {
            armedCount++;
            ghostDebited += amount; // amount==0 debits nothing (adds 0) — identity preserved
            hasLast = true;
            lastFields = f;
            lastDigest = digest;
            lastAmount = amount;
        } catch {
            armFailures++; // over-cap / cumulative / already-armed reverts are BY DESIGN
        }
    }

    /// Replay the last successful arm's exact fields. If that digest is still LIVE the arm
    /// MUST revert (`AlreadyArmed`); a success there means the idempotency guard is broken.
    function doRearm() external {
        if (!hasLast) return;
        bool live = acct.isValidSignature(lastDigest, "") == ERC1271_MAGIC;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sessionPk, lastDigest);
        vm.prank(session);
        try acct.authorizeSigningIntent(descriptorId, lastFields, new SigningLib.TokenCap[](0), abi.encodePacked(r, s, v), "") {
            if (live) {
                rearmGuardBroken = true; // double-debit of a live digest got through
            } else {
                ghostDebited += lastAmount; // a stale/expired digest legitimately re-debited
                rearmCount++;
            }
        } catch {
            armFailures++;
        }
    }

    function doWarp(uint256 dt) external {
        dt = bound(dt, 1, 3 hours);
        vm.warp(block.timestamp + dt);
    }
}

contract LeashAccountV5SigningInvariantTest is StdInvariant, Test {

    // FP-3: the flat `proposeSigningGrant` was removed (owners use the nested fn with a zeroed fold).
    // This helper preserves the FP-1 call convention, exercising the identical flat on-chain path.
    function _proposeFlat(
        uint256 id, bytes32 ds, bytes32 th, uint8 nf, uint8 si, uint8 ai, uint8 di,
        address token, uint128 cap, uint64 win, address[] memory sp
    ) internal {
        acct.proposeSigningGrantNested(
            SigningLib.SigningGrantParams(id, ds, th, nf, si, ai, di, type(uint8).max, bytes32(0), 0, 0, token, cap, win, 0, address(0)),
            sp,
            new SigningLib.TokenCap[](0)
        );
    }

    LeashAccountV5 internal acct;
    MockERC20 internal usd;
    SigningHandler internal handler;

    uint256 constant DESCRIPTOR_ID = 1;
    uint128 constant BUDGET = 500 ether;
    uint32 constant NON_RESETTING_WINDOW = uint32(3650 days); // budget never rolls over in-run

    function setUp() public {
        vm.warp(1_700_000_000);
        (address session, uint256 pk) = makeAddrAndKey("session");
        address owner = makeAddr("owner");
        address spender = makeAddr("spender");
        usd = new MockERC20("Test USD 18", "TUSD18", 18);
        address[] memory list = new address[](0);
        acct = new LeashAccountV5(
            owner, makeAddr("guardian"), session,
            LeashAccountV5.Policy(1 ether, 3 ether, NON_RESETTING_WINDOW, uint64(block.timestamp + 3650 days)),
            list, 0, address(usd), LeashAccountV5.TokenPolicy(0, 0), address(new SigningLib()), address(new DecodeLib())
        );
        usd.mint(address(acct), 1_000_000 ether);

        // budget (timelockDelay == 0 → apply is immediate)
        vm.prank(owner);
        acct.proposeSpendBudget(address(usd), BUDGET);
        vm.prank(owner);
        acct.applySpendBudget();

        bytes32 typeHash = keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
        bytes32 domainSep = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("P"), keccak256("1"), block.chainid, spender
            )
        );
        address[] memory sp = new address[](1);
        sp[0] = spender;
        vm.prank(owner);
        _proposeFlat(DESCRIPTOR_ID, domainSep, typeHash, 5, 1, 2, 4, address(usd), 100 ether, 1 hours, sp);
        vm.prank(owner);
        acct.applySigningGrant();

        handler = new SigningHandler(acct, session, pk, address(usd), DESCRIPTOR_ID, domainSep, typeHash, spender, 100 ether, 1 hours);
        targetContract(address(handler));
    }

    /// Bound: cumulative per-token signing spend can never exceed the owner-set window cap,
    /// no matter how many intents are armed (laddering closed).
    function invariant_signingNeverExceedsBudget() public view {
        (, uint128 windowCap, uint128 spent,) = acct.spendBudget(address(usd));
        assertLe(spent, windowCap, "cumulative signing spend must never exceed the per-token budget");
    }

    /// EXACT accounting identity (mutation-sensitive): with a non-resetting window, on-chain
    /// `spent` must equal the ghost sum of every notional the handler successfully armed.
    /// Delete `_debitSpendBudget` and this fails (spent stays 0; ghost grows).
    function invariant_spentEqualsDebitedSum() public view {
        (,, uint128 spent,) = acct.spendBudget(address(usd));
        assertEq(uint256(spent), handler.ghostDebited(), "on-chain spent must equal the debited ghost sum");
    }

    /// The re-arm idempotency guard holds: a live digest was never double-debited.
    /// Delete the `AlreadyArmed` check and the re-arm handler trips this.
    function invariant_rearmGuardHolds() public view {
        assertFalse(handler.rearmGuardBroken(), "re-arming a LIVE digest must always revert (no double-debit)");
    }
}
