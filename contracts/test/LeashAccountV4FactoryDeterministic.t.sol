// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {LeashAccountV4FactoryDeterministic} from "../src/LeashAccountV4FactoryDeterministic.sol";
import {LeashAccountV4Factory} from "../src/LeashAccountV4Factory.sol";
import {LeashAccountV4} from "../src/LeashAccountV4.sol";
import {MockERC20} from "../src/MockERC20.sol";

/// Stage E, SE-6 — the deterministic (CREATE2) v4 factory.
///
/// The address of a v4 account must be a pure function of
/// (factory address, owner, salt, construction args): deployed on any EVM chain
/// where the factory sits at the same address, the same (owner, salt) + the same
/// canonical construction tuple yields the SAME account address (E-6). Anything
/// that diverges — factory, salt, owner, or any construction arg — yields a
/// DIFFERENT address, which is exactly what the backend's assertSameAddress
/// detects and refuses before funds are routed cross-chain (spec §8 CREATE2
/// address-spoof).
contract LeashAccountV4FactoryDeterministicTest is Test {
    LeashAccountV4FactoryDeterministic internal factory;
    MockERC20 internal usd;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal session = makeAddr("session");
    bytes32 internal salt = keccak256("agent-1");

    function setUp() public {
        vm.warp(1_700_000_000);
        factory = new LeashAccountV4FactoryDeterministic();
        usd = new MockERC20("T", "T", 6);
    }

    function _policy() internal view returns (LeashAccountV4.Policy memory) {
        return LeashAccountV4.Policy({
            perTransferCap: 1 ether,
            windowCap: 3 ether,
            windowSeconds: 1 hours,
            expiresAt: uint64(block.timestamp + 30 days)
        });
    }

    function _tokenPolicy() internal pure returns (LeashAccountV4.TokenPolicy memory) {
        return LeashAccountV4.TokenPolicy(100e6, 250e6);
    }

    function _create(address owner_, bytes32 salt_) internal returns (address) {
        address[] memory list = new address[](0);
        return factory.createAccountV4(
            owner_, guardian, session, _policy(), list, 15 minutes, address(0), _tokenPolicy(), salt_
        );
    }

    function _predict(address owner_, bytes32 salt_) internal view returns (address) {
        address[] memory list = new address[](0);
        return factory.predictAccountV4(
            owner_, guardian, session, _policy(), list, 15 minutes, address(0), _tokenPolicy(), salt_
        );
    }

    // ---------- determinism core (E-6) ----------

    function test_predictMatchesDeploy() public {
        address predicted = _predict(owner, salt);
        address acct = _create(owner, salt);
        assertEq(acct, predicted, "CREATE2 address must equal the prediction");
        assertGt(acct.code.length, 0);
    }

    function testFuzz_predictMatchesDeploy(address owner_, bytes32 salt_, uint128 cap) public {
        vm.assume(owner_ != address(0));
        vm.assume(cap > 0);
        address[] memory list = new address[](0);
        LeashAccountV4.Policy memory p = LeashAccountV4.Policy({
            perTransferCap: cap,
            windowCap: cap,
            windowSeconds: 1 hours,
            expiresAt: uint64(block.timestamp + 30 days)
        });
        address predicted =
            factory.predictAccountV4(owner_, guardian, session, p, list, 0, address(0), _tokenPolicy(), salt_);
        address acct =
            factory.createAccountV4(owner_, guardian, session, p, list, 0, address(0), _tokenPolicy(), salt_);
        assertEq(acct, predicted);
    }

    function test_sameTuple_redeployReverts() public {
        address acct = _create(owner, salt);
        vm.expectRevert(
            abi.encodeWithSelector(LeashAccountV4FactoryDeterministic.AccountAlreadyDeployed.selector, acct)
        );
        _create(owner, salt);
    }

    function test_saltAndOwnerDivergence() public {
        address a = _create(owner, salt);
        address b = _create(owner, keccak256("agent-2"));
        address c = _create(makeAddr("other-owner"), salt);
        assertTrue(a != b, "different salt must land at a different address");
        assertTrue(a != c, "different owner must land at a different address");
        assertTrue(b != c);
    }

    function test_argDivergenceChangesAddress() public {
        // The construction tuple is part of the CREATE2 initcode: ANY arg change
        // (here the session key) moves the address. This is what makes an
        // arg-divergent cross-chain replica DETECTABLE (predicted != expected).
        address[] memory list = new address[](0);
        address a = factory.predictAccountV4(
            owner, guardian, session, _policy(), list, 15 minutes, address(0), _tokenPolicy(), salt
        );
        address b = factory.predictAccountV4(
            owner, guardian, makeAddr("other-session"), _policy(), list, 15 minutes, address(0), _tokenPolicy(), salt
        );
        assertTrue(a != b, "an arg-divergent tuple must not collide with the canonical address");
    }

    // ---------- the account is a REAL v4 wall account ----------

    function test_accountBytecodeIdenticalToPlainFactory() public {
        // The deterministic factory embeds the SAME LeashAccountV4 creation code
        // as the plain Stage-D factory: runtime bytecode (and therefore the whole
        // executeCall wall) is byte-identical.
        address det = _create(owner, salt);
        LeashAccountV4Factory plain = new LeashAccountV4Factory();
        address[] memory list = new address[](0);
        address ref = plain.createAccountV4(
            owner, guardian, session, _policy(), list, 15 minutes, address(0), _tokenPolicy()
        );
        assertEq(det.codehash, ref.codehash, "deterministic account bytecode must equal the plain v4 account");
    }

    function test_accountStateAndWallLive() public {
        address acct = _create(owner, salt);
        LeashAccountV4 a = LeashAccountV4(payable(acct));
        assertEq(a.owner(), owner);
        assertEq(a.sessionKey(), session);
        assertEq(a.guardian(), guardian);
        // the factory keeps NO authority
        assertTrue(a.owner() != address(factory));
        // the governed-calldata wall is live: an off-allowlist executeCall REVERTS.
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(LeashAccountV4.TargetNotAllowlisted.selector, address(usd)));
        a.executeCall(address(usd), 0, abi.encodeWithSignature("approve(address,uint256)", address(this), 1));
    }

    function test_eventCarriesSalt() public {
        address predicted = _predict(owner, salt);
        vm.expectEmit(true, true, false, true);
        emit LeashAccountV4FactoryDeterministic.AccountCreatedV4(predicted, owner, session, guardian, salt);
        _create(owner, salt);
    }

    function test_versionConstant() public view {
        assertEq(factory.ACCOUNT_VERSION_V4(), 4);
    }

    function test_factory_underEip170SizeLimit() public view {
        assertLe(address(factory).code.length, 24576, "deterministic V4 factory exceeds EIP-170 limit");
    }

    // ---------- adversarial (D-12 slice: CREATE2 address-spoof class) ----------

    function test_frontRunGainsNothing() public {
        // An attacker who observes the canonical tuple and deploys FIRST only
        // instantiates the owner's exact account (state from args): the attacker
        // gains no authority, and the owner's own create simply reverts.
        vm.prank(makeAddr("frontrunner"));
        address acct = _create(owner, salt);
        LeashAccountV4 a = LeashAccountV4(payable(acct));
        assertEq(a.owner(), owner, "front-run deploy still belongs to the owner");
        assertEq(a.sessionKey(), session);
        vm.expectRevert(
            abi.encodeWithSelector(LeashAccountV4FactoryDeterministic.AccountAlreadyDeployed.selector, acct)
        );
        _create(owner, salt);
    }

    function test_spoofTupleCannotOccupyCanonicalAddress() public {
        // An attacker-controlled tuple (attacker session key) can NEVER occupy the
        // canonical (owner, salt) address — the initcode hash differs, so CREATE2
        // lands elsewhere. The canonical address stays deployable + canonical.
        address canonical = _predict(owner, salt);
        address[] memory list = new address[](0);
        vm.prank(makeAddr("attacker"));
        address spoof = factory.createAccountV4(
            owner, guardian, makeAddr("attacker-session"), _policy(), list, 15 minutes, address(0), _tokenPolicy(), salt
        );
        assertTrue(spoof != canonical, "a spoofed tuple must not land at the canonical address");
        address acct = _create(owner, salt);
        assertEq(acct, canonical);
    }

    function testFuzz_distinctSaltsNeverCollide(bytes32 s1, bytes32 s2) public view {
        vm.assume(s1 != s2);
        assertTrue(_predict(owner, s1) != _predict(owner, s2));
    }
}
