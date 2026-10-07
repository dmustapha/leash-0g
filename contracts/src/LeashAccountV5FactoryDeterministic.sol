// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {LeashAccountV5} from "./LeashAccountV5.sol";

/// @title LeashAccountV5FactoryDeterministic — CREATE2 deterministic deploys of
///        governed-calldata + governed-signing (v5) accounts, for cross-chain
///        same-address (SE-6), version-selected (SE-1).
/// @notice Stage F′ (FP-1). Byte-for-byte the Stage-E V4 deterministic factory, but
///         embedding the NEW `LeashAccountV5` creation code. The construction tuple is
///         IDENTICAL to V4 (signing descriptors/rules are granted post-deploy, exactly
///         like call rules), so V5 accounts land deterministically at an address that is
///         a pure function of (factory, owner, salt, args). V5 initcode differs from V4
///         initcode, so a V5 account lands at a DIFFERENT address than a V4 account for
///         the same (owner, salt) — the expected, correct consequence of a new immutable
///         version. With this factory at the SAME address on every chain and an identical
///         tuple, the same (owner, salt) lands the V5 account at the SAME address
///         everywhere (`07 S16`); any divergence is what the backend's assertSameAddress
///         REFUSES before routing funds cross-chain.
///
///         Legacy + V4 bytecode is UNTOUCHED — this factory never references them. The
///         deployer (LEASH ops key) pays create gas but is granted NO authority: `owner`
///         is the user's wallet; the factory keeps nothing. Deterministic deploys are
///         front-run-safe by construction (all authority is baked into the initcode).
contract LeashAccountV5FactoryDeterministic {
    event AccountCreatedV5(
        address indexed account, address indexed owner, address sessionKey, address guardian, bytes32 salt
    );

    /// @notice The (owner, salt) slot is already occupied — the account exists.
    error AccountAlreadyDeployed(address account);

    /// @notice Version constant the registry/backend use to distinguish a v5 account (SE-1).
    uint8 public constant ACCOUNT_VERSION_V5 = 5;

    /// @dev FP-3: the stateless pure helper singletons every account this factory deploys is wired to
    ///      (signing fold + grant validation; governed-call decode). Immutable — baked into the account
    ///      initcode, so the deterministic (cross-chain same-address) property holds as long as the
    ///      helpers are at the same address on every chain (deploy them via CREATE2 + a fixed salt).
    address public immutable signingHelper;
    address public immutable decodeHelper;

    constructor(address signingHelper_, address decodeHelper_) {
        signingHelper = signingHelper_;
        decodeHelper = decodeHelper_;
    }

    function createAccountV5(
        address owner,
        address guardian,
        address sessionKey,
        LeashAccountV5.Policy calldata initialPolicy,
        address[] calldata initialAllowlist,
        uint64 timelockDelay,
        address settlementToken,
        LeashAccountV5.TokenPolicy calldata initialTokenPolicy,
        bytes32 salt
    ) external returns (address account) {
        address predicted = predictAccountV5(
            owner, guardian, sessionKey, initialPolicy, initialAllowlist, timelockDelay, settlementToken, initialTokenPolicy, salt
        );
        if (predicted.code.length != 0) revert AccountAlreadyDeployed(predicted);
        account = address(
            new LeashAccountV5{salt: _create2Salt(owner, salt)}(
                owner,
                guardian,
                sessionKey,
                initialPolicy,
                initialAllowlist,
                timelockDelay,
                settlementToken,
                initialTokenPolicy,
                signingHelper,
                decodeHelper
            )
        );
        assert(account == predicted);
        emit AccountCreatedV5(account, owner, sessionKey, guardian, salt);
    }

    /// @notice Predict the deterministic account address — the cross-chain verification
    ///         hook: the backend eth_calls this on every target chain and REFUSES routing
    ///         when predictions diverge (E-6).
    function predictAccountV5(
        address owner,
        address guardian,
        address sessionKey,
        LeashAccountV5.Policy calldata initialPolicy,
        address[] calldata initialAllowlist,
        uint64 timelockDelay,
        address settlementToken,
        LeashAccountV5.TokenPolicy calldata initialTokenPolicy,
        bytes32 salt
    ) public view returns (address) {
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                type(LeashAccountV5).creationCode,
                abi.encode(
                    owner,
                    guardian,
                    sessionKey,
                    initialPolicy,
                    initialAllowlist,
                    timelockDelay,
                    settlementToken,
                    initialTokenPolicy,
                    signingHelper,
                    decodeHelper
                )
            )
        );
        return address(
            uint160(uint256(keccak256(abi.encodePacked(hex"ff", address(this), _create2Salt(owner, salt), initCodeHash))))
        );
    }

    /// @dev The effective CREATE2 salt commits to the owner (salt scoping).
    function _create2Salt(address owner, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encode(owner, salt));
    }
}
