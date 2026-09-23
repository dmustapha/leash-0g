// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {LeashAccount} from "./LeashAccount.sol";

/// @title LeashAccountFactory — deploys one LeashAccount per agent.
/// @notice The deployer (LEASH ops key) pays create gas but is granted NO authority
///         on the account: `owner` is the user's wallet; the factory keeps nothing.
contract LeashAccountFactory {
    event AccountCreated(address indexed account, address indexed owner, address sessionKey, address guardian);

    /// @notice Create a v3 account. `settlementToken == address(0)` yields a
    ///         native-only account (identical spend surface to a legacy v2
    ///         account — additive migration, S7; no forced migration). A non-zero
    ///         token makes the account token-capable with its own per-token caps.
    function createAccount(
        address owner,
        address guardian,
        address sessionKey,
        LeashAccount.Policy calldata initialPolicy,
        address[] calldata initialAllowlist,
        uint64 timelockDelay,
        address settlementToken,
        LeashAccount.TokenPolicy calldata initialTokenPolicy
    ) external returns (address account) {
        account = address(
            new LeashAccount(
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
        emit AccountCreated(account, owner, sessionKey, guardian);
    }
}
