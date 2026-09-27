// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {LeashAccountV4} from "../../src/LeashAccountV4.sol";

/// Test-only harness: exposes LeashAccountV4's REAL internal decode primitives
/// (`_decodeAddress` / `_decodeUint`) so the D-15 differential decode oracle can diff
/// the on-chain parse against viem over the real-calldata corpus. No logic is
/// reimplemented — these call the exact functions the wall uses, incl. the strict
/// canonical dirty-high-bits `DecodeMismatch` revert (H-04).
contract V4DecoderHarness is LeashAccountV4 {
    constructor(address owner_, address session_)
        LeashAccountV4(
            owner_,
            owner_,
            session_,
            Policy({perTransferCap: type(uint128).max, windowCap: type(uint128).max, windowSeconds: 1 hours, expiresAt: type(uint64).max}),
            new address[](0),
            0,
            address(0),
            TokenPolicy(0, 0)
        )
    {}

    function decodeAddress(bytes calldata data, uint256 offset) external pure returns (address) {
        return _decodeAddress(data, offset);
    }

    function decodeUint(bytes calldata data, uint256 offset) external pure returns (uint256) {
        return _decodeUint(data, offset);
    }
}
