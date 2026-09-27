// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {LeashAccountV4} from "./LeashAccountV4.sol";

/// @title LeashAccountV4Factory — deploys one governed-calldata (v4) account per agent.
/// @notice Stage D. A DEDICATED factory: inlining both the legacy `LeashAccount` and
///         `LeashAccountV4` creation code into a single factory exceeds the EIP-170
///         24,576-byte contract-size limit (caught by the deployed drill), so v4 gets
///         its own factory. The legacy `LeashAccountFactory` stays byte-for-byte
///         unchanged (v2/v3 accounts frozen on their own bytecode, F9 mixed-support).
///         The deployer (LEASH ops key) pays create gas but is granted NO authority:
///         `owner` is the user's wallet; the factory keeps nothing.
contract LeashAccountV4Factory {
    event AccountCreatedV4(address indexed account, address indexed owner, address sessionKey, address guardian);

    /// @notice Version constant the registry/backend use to distinguish a v4 account.
    uint8 public constant ACCOUNT_VERSION_V4 = 4;

    /// @notice Create a v4 (governed-calldata) account. Identical construction args to
    ///         v3; the account additionally exposes the `executeCall` governed-calldata
    ///         path + grant surface. Native `execute` still reverts `CalldataForbidden`.
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
