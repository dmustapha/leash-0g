// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {LeashAccount} from "./LeashAccount.sol";
import {LeashAccountV4} from "./LeashAccountV4.sol";

/// @title LeashAccountFactory — deploys one LeashAccount per agent.
/// @notice The deployer (LEASH ops key) pays create gas but is granted NO authority
///         on the account: `owner` is the user's wallet; the factory keeps nothing.
contract LeashAccountFactory {
    event AccountCreated(address indexed account, address indexed owner, address sessionKey, address guardian);
    event AccountCreatedV4(address indexed account, address indexed owner, address sessionKey, address guardian);

    /// @notice Version constant for the governed-calldata account the registry/backend
    ///         use to distinguish a v4 account from legacy native/settlement accounts.
    uint8 public constant ACCOUNT_VERSION_V4 = 4;

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

    /// @notice Create a v4 (governed-calldata) account (Stage D). Identical
    ///         construction args to v3; the account additionally exposes the
    ///         `executeCall` governed-calldata path + grant surface. Legacy v2/v3
    ///         accounts already on-chain are frozen on their own bytecode and
    ///         unaffected (F9 mixed-support). `version == 4` distinguishes it for the
    ///         registry + backend. Native `execute` still reverts `CalldataForbidden`.
    function createAccountV4(
        address owner,
        address guardian,
        address sessionKey,
        LeashAccountV4.Policy calldata initialPolicy,
        address[] calldata initialAllowlist,
        uint64 timelockDelay,
        address settlementToken,
        LeashAccountV4.TokenPolicy calldata initialTokenPolicy
    ) external returns (address account) {
        account = address(
            new LeashAccountV4(
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
        emit AccountCreatedV4(account, owner, sessionKey, guardian);
    }
}
