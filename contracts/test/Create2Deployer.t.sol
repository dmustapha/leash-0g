// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Create2Deployer} from "../src/Create2Deployer.sol";
import {LeashAccountV5} from "../src/LeashAccountV5.sol";
import {DecodeLib} from "../src/DecodeLib.sol";
import {SigningLib} from "../src/SigningLib.sol";
import {MockERC20} from "../src/MockERC20.sol";

/// Stage F′ FP-4 P1 — the generic CREATE2 deployer that replaces the embedding factory
/// (EIP-170 rework). Proves: same-address via off-chain initcode, redeploy fails closed,
/// the backend owner-scoped salt derivation, and the RULING-B read-back (owner + both
/// helper immutables are exactly what the initcode baked in).
contract Create2DeployerTest is Test {
    Create2Deployer internal deployer;
    SigningLib internal signingHelper;
    DecodeLib internal decodeHelper;
    MockERC20 internal usd;

    address internal owner = makeAddr("owner");
    address internal owner2 = makeAddr("owner2");
    address internal guardian = makeAddr("guardian");
    address internal session = makeAddr("session");

    uint64 constant DELAY = 15 minutes;

    function setUp() public {
        deployer = new Create2Deployer();
        signingHelper = new SigningLib();
        decodeHelper = new DecodeLib();
        usd = new MockERC20("USD", "USD", 18);
    }

    function _policy() internal view returns (LeashAccountV5.Policy memory) {
        return LeashAccountV5.Policy({
            perTransferCap: 1 ether,
            windowCap: 3 ether,
            windowSeconds: 1 hours,
            expiresAt: uint64(block.timestamp + 30 days)
        });
    }

    /// The backend assembles this exact byte string off-chain: account creationCode ++ the
    /// abi-encoded constructor tuple (incl. the two pinned helper singletons). The deployer
    /// never sees the account type — it only sees these bytes.
    function _initcode(address acctOwner) internal view returns (bytes memory) {
        return abi.encodePacked(
            type(LeashAccountV5).creationCode,
            abi.encode(
                acctOwner,
                guardian,
                session,
                _policy(),
                new address[](0),
                DELAY,
                address(usd),
                LeashAccountV5.TokenPolicy(0, 0),
                address(signingHelper),
                address(decodeHelper)
            )
        );
    }

    /// R-4: the backend commits the salt to the owner off-chain, then passes the scoped bytes32.
    function _scopedSalt(address acctOwner, bytes32 agentSalt) internal pure returns (bytes32) {
        return keccak256(abi.encode(acctOwner, agentSalt));
    }

    function test_deployLandsAtPredicted() public {
        bytes memory initcode = _initcode(owner);
        bytes32 salt = _scopedSalt(owner, keccak256("agent-1"));

        address predicted = deployer.predict(salt, keccak256(initcode));
        address created = deployer.deploy(salt, initcode);

        assertEq(created, predicted, "CREATE2 deploy must land at the predicted address");
        assertGt(created.code.length, 0, "account must have code");
    }

    /// The off-chain CREATE2 formula (what the backend computes without an RPC) must equal
    /// the on-chain predict view — the source-of-truth cross-check (RULING-A).
    function test_offchainPredictMatchesOnchain() public view {
        bytes32 salt = _scopedSalt(owner, keccak256("agent-2"));
        bytes32 initCodeHash = keccak256(_initcode(owner));
        address offchain = address(
            uint160(uint256(keccak256(abi.encodePacked(hex"ff", address(deployer), salt, initCodeHash))))
        );
        assertEq(offchain, deployer.predict(salt, initCodeHash), "off-chain predict must match on-chain");
    }

    /// RULING-B: the deployed account's owner + both helper immutables are EXACTLY what the
    /// initcode baked in — the read-back the onboarding path asserts before funds route.
    function test_rulingB_immutablesMatchInitcode() public {
        bytes32 salt = _scopedSalt(owner, keccak256("agent-3"));
        LeashAccountV5 acct = LeashAccountV5(payable(deployer.deploy(salt, _initcode(owner))));
        assertEq(acct.owner(), owner, "owner read-back");
        assertEq(acct.signingHelper(), address(signingHelper), "signingHelper read-back");
        assertEq(acct.decodeHelper(), address(decodeHelper), "decodeHelper read-back");
    }

    /// A redeploy to the same (salt, initcode) slot fails closed — create2 returns 0, we revert.
    function test_redeploy_reverts() public {
        bytes32 salt = _scopedSalt(owner, keccak256("agent-4"));
        bytes memory initcode = _initcode(owner);
        deployer.deploy(salt, initcode);
        vm.expectRevert(Create2Deployer.DeployFailed.selector);
        deployer.deploy(salt, initcode);
    }

    /// Empty initcode deploys a zero-code account (create2 returns a non-zero address but no code)
    /// → fails closed on the EmptyAccount guard (no silent zero-code account slips through).
    function test_emptyInitcode_reverts() public {
        vm.expectRevert(Create2Deployer.EmptyAccount.selector);
        deployer.deploy(keccak256("x"), bytes(""));
    }

    /// Two different owners with the SAME agent-salt can never collide: the owner is in the
    /// initcode AND (R-4) in the scoped salt, so both inputs to CREATE2 differ → different address.
    function test_differentOwners_noCollision() public {
        bytes32 agentSalt = keccak256("shared-agent-salt");
        address a1 = deployer.deploy(_scopedSalt(owner, agentSalt), _initcode(owner));
        address a2 = deployer.deploy(_scopedSalt(owner2, agentSalt), _initcode(owner2));
        assertTrue(a1 != a2, "different owners must never collide to one address");
    }
}
