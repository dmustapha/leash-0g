// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockERC20 (TestUSD) — a TEST-ONLY settlement token for LEASH Phase 4.
/// @notice 6-decimal ERC-20 with an OPEN faucet mint, deployed on 0G testnet
///         16602 for the governed-settlement demo. This is NOT USDC and holds no
///         value — real USDC / mainnet / real funds are deferred (07 #16: legal
///         review + P4C-1 first). Labelled clearly so no one mistakes it for a
///         production stablecoin.
contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Open testnet faucet — anyone can mint TestUSD to fund an account.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
