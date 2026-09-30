// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title MockBridge — a TEST-ONLY OP-stack-StandardBridge-shaped target for LEASH SE-8.
/// @notice Mirrors the two canonical OP-stack bridge entrypoints the governed-calldata
///         wall carries structured decoders for. Recipient pinning + amount capping for
///         these selectors live in the account's `_checkStructuredArgs` bridge decoders —
///         NOT here. The mock only records the bridged legs (no real message passing).
contract MockBridge {
    event ETHBridgeInitiated(address indexed from, address indexed to, uint256 amount, bytes extraData);
    event ERC20BridgeInitiated(
        address indexed localToken, address indexed remoteToken, address indexed to, uint256 amount, bytes extraData
    );

    mapping(address => uint256) public ethBridged; // to => total
    mapping(address => uint256) public erc20Bridged; // to => total

    /// bridgeETHTo(address,uint32,bytes) — canonical OP-stack, payable.
    function bridgeETHTo(address to, uint32, bytes calldata extraData) external payable {
        ethBridged[to] += msg.value;
        emit ETHBridgeInitiated(msg.sender, to, msg.value, extraData);
    }

    /// bridgeERC20To(address,address,address,uint256,uint32,bytes) — canonical OP-stack.
    function bridgeERC20To(
        address localToken,
        address remoteToken,
        address to,
        uint256 amount,
        uint32,
        bytes calldata extraData
    ) external {
        IERC20(localToken).transferFrom(msg.sender, address(this), amount);
        erc20Bridged[to] += amount;
        emit ERC20BridgeInitiated(localToken, remoteToken, to, amount, extraData);
    }
}
