// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {LeashAccountV4} from "./LeashAccountV4.sol";

/// @title LeashAccountV4FactoryDeterministic — CREATE2 deterministic deploys of
///        governed-calldata (v4) accounts, for cross-chain same-address (SE-6).
/// @notice Stage E. The account address is a pure function of
///         (factory address, owner, salt, construction args): with this factory
///         deployed at the SAME address on every chain (via the canonical CREATE2
///         deployer) and an IDENTICAL construction tuple, the same (owner, salt)
///         lands the account at the SAME address everywhere — the multichain
///         funding anchor (`07 S16`). Anything that diverges (factory, salt,
///         owner, or any construction arg) lands elsewhere, which is exactly what
///         the backend's assertSameAddress detects and REFUSES before funds are
///         routed cross-chain (spec §8 CREATE2 address-spoof).
///
///         The account bytecode is UNTOUCHED: this factory embeds the same
///         `LeashAccountV4` creation code as the Stage-D plain factory, so the
///         deployed wall is byte-identical (proven by a codehash-equality test).
///         The deployer (LEASH ops key) pays create gas but is granted NO
///         authority: `owner` is the user's wallet; the factory keeps nothing.
///         Deterministic deploys are front-run-safe by construction — a
///         front-runner can only instantiate the owner's exact account (all
///         authority state comes from the args baked into the initcode).
contract LeashAccountV4FactoryDeterministic {
    event AccountCreatedV4(
        address indexed account, address indexed owner, address sessionKey, address guardian, bytes32 salt
    );

    /// @notice The (owner, salt) slot is already occupied — the account exists.
    error AccountAlreadyDeployed(address account);

    /// @notice Version constant the registry/backend use to distinguish a v4 account.
    uint8 public constant ACCOUNT_VERSION_V4 = 4;

    /// @notice Create a v4 account at its deterministic address. Construction args
    ///         are identical to the plain v4 factory, plus the CREATE2 `salt`.
    ///         The effective CREATE2 salt commits to the owner (keccak(owner, salt))
    ///         so a salt is scoped per owner by construction.
    function createAccountV4(
        address owner,
        address guardian,
        address sessionKey,
        LeashAccountV4.Policy calldata initialPolicy,
        address[] calldata initialAllowlist,
        uint64 timelockDelay,
        address settlementToken,
        LeashAccountV4.TokenPolicy calldata initialTokenPolicy,
        bytes32 salt
    ) external returns (address account) {
        address predicted = predictAccountV4(
            owner, guardian, sessionKey, initialPolicy, initialAllowlist, timelockDelay, settlementToken, initialTokenPolicy, salt
        );
        if (predicted.code.length != 0) revert AccountAlreadyDeployed(predicted);
        account = address(
            new LeashAccountV4{salt: _create2Salt(owner, salt)}(
                owner,
                guardian,
                sessionKey,
                initialPolicy,
                initialAllowlist,
                timelockDelay,
                settlementToken,
                initialTokenPolicy
            )
        );
        // CREATE2 is fully deterministic — the deploy can only land at the prediction.
        assert(account == predicted);
        emit AccountCreatedV4(account, owner, sessionKey, guardian, salt);
    }

    /// @notice Predict the deterministic account address for a construction tuple —
    ///         the cross-chain verification hook: the backend eth_calls this on every
    ///         target chain and REFUSES routing when predictions diverge (E-6).
    function predictAccountV4(
        address owner,
        address guardian,
        address sessionKey,
        LeashAccountV4.Policy calldata initialPolicy,
        address[] calldata initialAllowlist,
        uint64 timelockDelay,
        address settlementToken,
        LeashAccountV4.TokenPolicy calldata initialTokenPolicy,
        bytes32 salt
    ) public view returns (address) {
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                type(LeashAccountV4).creationCode,
                abi.encode(
                    owner,
                    guardian,
                    sessionKey,
                    initialPolicy,
                    initialAllowlist,
                    timelockDelay,
                    settlementToken,
                    initialTokenPolicy
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
