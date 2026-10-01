// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title MockGatewayRouter — a TEST-ONLY Arbitrum-L2-GatewayRouter-shaped target (SE-9).
/// @notice Mirrors the Arbitrum L2→L1 ERC-20 withdrawal entrypoint
///         `outboundTransfer(address l1Token, address to, uint256 amount, bytes data)`.
///         DIVERGENT from the OP-stack bridge: `l1Token` IS the remote token (there is
///         NO separate remoteToken arg), and there is NO minGasLimit arg. The router
///         pulls the configured L2 token from the caller (the account approved it),
///         just as the real gateway pulls the mapped L2 token. Recipient pinning + the
///         amount cap live in the account's `_checkBridgeArgs` decoder — NOT here.
contract MockGatewayRouter {
    event OutboundTransfer(address indexed l1Token, address indexed to, uint256 amount, bytes data);

    mapping(address => uint256) public outbound; // to => total withdrawn
    IERC20 public immutable l2Token; // the L2 token this router pulls on withdrawal

    constructor(IERC20 l2Token_) {
        l2Token = l2Token_;
    }

    function outboundTransfer(address l1Token, address to, uint256 amount, bytes calldata data)
        external
        returns (bytes memory)
    {
        l2Token.transferFrom(msg.sender, address(this), amount);
        outbound[to] += amount;
        emit OutboundTransfer(l1Token, to, amount, data);
        return "";
    }
}

/// @title MockArbSys — a TEST-ONLY ArbSys-shaped target (SE-9).
/// @notice Mirrors the Arbitrum L2→L1 ETH withdrawal precompile entrypoint
///         `withdrawEth(address destination)` (payable, single-arg, NO minGasLimit /
///         NO extraData — maximally divergent from OP-stack `bridgeETHTo`). The
///         recipient pin lives in the account's decoder.
contract MockArbSys {
    event WithdrawEth(address indexed destination, uint256 amount);

    mapping(address => uint256) public withdrawn; // destination => total

    function withdrawEth(address destination) external payable returns (uint256) {
        withdrawn[destination] += msg.value;
        emit WithdrawEth(destination, msg.value);
        return msg.value;
    }
}
