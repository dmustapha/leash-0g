// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title MockRouter — a TEST-ONLY DEX-router-shaped target for LEASH Stage D.
/// @notice Proves the governed-calldata wall's EXECUTION path against a realistic
///         swap shape (approve → swap) on 0G, with NO real liquidity/protocol
///         (live-protocol integration is Stage E). `swap` uses a fixed-position
///         (static) signature so it is not a dynamic-arg decode case: it pulls
///         `amountIn` of `tokenIn` from the caller (requires a prior `approve`) and
///         sends `amountOut` of `tokenOut` to `recipient`. Holds no value.
contract MockRouter {
    event Swapped(
        address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, address recipient
    );

    /// swap(address,address,uint256,uint256,address,uint256) — all static positions.
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        address recipient,
        uint256 deadline
    ) external returns (uint256 amountOut) {
        require(block.timestamp <= deadline, "expired");
        require(amountOutMin > 0, "minOut=0"); // H-01: reject zero-floor swaps
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        // 1:1 mock rate; must clear the caller's slippage floor.
        amountOut = amountIn;
        require(amountOut >= amountOutMin, "slippage");
        IERC20(tokenOut).transfer(recipient, amountOut);
        emit Swapped(tokenIn, tokenOut, amountIn, amountOut, recipient);
    }
}
