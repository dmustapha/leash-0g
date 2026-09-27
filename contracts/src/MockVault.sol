// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title MockVault — a TEST-ONLY ERC-4626-shaped target for LEASH Stage D.
/// @notice Proves the governed-calldata wall against a vault-deposit shape
///         (approve → deposit) on 0G. `deposit(uint256 assets, address receiver)` is
///         the canonical ERC-4626 static signature; the wall pins `receiver == self`
///         (C-04) via the structured decoder only when granted with recipientMode.
///         Pulls `assets` of the underlying from the caller (requires a prior
///         `approve`) and credits `shares[receiver]`.
contract MockVault {
    IERC20 public immutable asset;
    mapping(address => uint256) public shares;

    event Deposit(address indexed caller, address indexed receiver, uint256 assets, uint256 shares);

    constructor(IERC20 asset_) {
        asset = asset_;
    }

    /// deposit(uint256,address) — canonical ERC-4626, static positions.
    function deposit(uint256 assets, address receiver) external returns (uint256 sharesOut) {
        asset.transferFrom(msg.sender, address(this), assets);
        sharesOut = assets; // 1:1 mock
        shares[receiver] += sharesOut;
        emit Deposit(msg.sender, receiver, assets, sharesOut);
    }
}
