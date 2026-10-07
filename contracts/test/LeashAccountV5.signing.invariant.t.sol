// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Vm} from "forge-std/Vm.sol";
import {LeashAccountV5} from "../src/LeashAccountV5.sol";
import {MockERC20} from "../src/MockERC20.sol";

/// Fuzzes valid-signature signing-intent arming + time warps against the wall. Each arm
/// produces a real session-key ECDSA signature, so only genuinely-authorized intents are
/// attempted — the invariant then proves the enforcement locus holds.
contract SigningHandler {
    Vm internal constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

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

    uint256 public armedCount;

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

    function doArm(uint256 amount, uint256 dOffset, uint256 nonce) external {
        amount = bound(amount, 0, uint256(perIntentCap));
        dOffset = bound(dOffset, 1, uint256(maxWindow));
        uint256 deadline = block.timestamp + dOffset;
        bytes32[] memory f = new bytes32[](5);
        f[0] = bytes32(uint256(uint160(spender))); // owner field (unused role)
        f[1] = bytes32(uint256(uint160(spender)));
        f[2] = bytes32(amount);
        f[3] = bytes32(nonce);
        f[4] = bytes32(deadline);
        bytes32 structHash = keccak256(abi.encodePacked(typeHash, f));
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", domainSep, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sessionPk, digest);
        vm.prank(session);
        try acct.authorizeSigningIntent(descriptorId, f, abi.encodePacked(r, s, v)) {
            armedCount++;
        } catch {}
    }

    function doWarp(uint256 dt) external {
        dt = bound(dt, 1, 3 hours);
        vm.warp(block.timestamp + dt);
    }

    function bound(uint256 x, uint256 lo, uint256 hi) internal pure returns (uint256) {
        if (hi <= lo) return lo;
        return lo + (x % (hi - lo + 1));
    }
}

contract LeashAccountV5SigningInvariantTest is StdInvariant, Test {
    LeashAccountV5 internal acct;
    MockERC20 internal usd;
    SigningHandler internal handler;

    uint256 constant DESCRIPTOR_ID = 1;
    uint128 constant BUDGET = 500 ether;

    function setUp() public {
        vm.warp(1_700_000_000);
        (address session, uint256 pk) = makeAddrAndKey("session");
        address owner = makeAddr("owner");
        address spender = makeAddr("spender");
        usd = new MockERC20("Test USD 18", "TUSD18", 18);
        address[] memory list = new address[](0);
        acct = new LeashAccountV5(
            owner, makeAddr("guardian"), session,
            LeashAccountV5.Policy(1 ether, 3 ether, 1 hours, uint64(block.timestamp + 3650 days)),
            list, 0, address(usd), LeashAccountV5.TokenPolicy(0, 0)
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
        acct.proposeSigningGrant(DESCRIPTOR_ID, domainSep, typeHash, 5, 1, 2, 4, address(usd), 100 ether, 1 hours, sp);
        vm.prank(owner);
        acct.applySigningGrant();

        handler = new SigningHandler(acct, session, pk, address(usd), DESCRIPTOR_ID, domainSep, typeHash, spender, 100 ether, 1 hours);
        targetContract(address(handler));
    }

    /// signing ≤ calling spine: the cumulative per-token spend can never exceed the
    /// owner-set window cap, no matter how many intents are armed (laddering closed).
    function invariant_signingNeverExceedsBudget() public view {
        (, uint128 windowCap, uint128 spent,) = acct.spendBudget(address(usd));
        assertLe(spent, windowCap, "cumulative signing spend must never exceed the per-token budget");
    }
}
