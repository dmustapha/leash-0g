import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';

/**
 * AQ-FND M-3 inc-3a — the swap-to-gas call builder (token -> native on a Uniswap V3 chain).
 *
 * Builds the three SWAP-SIDE legs of the route (the fourth, the account->session-key refuel, is
 * `buildAccountNativeRefuel`). EVERY argument is server-determined — owner config
 * (`ChainConfig.canonical.router`, `ChainConfig.gasSwap`), the spendable token the planner
 * chose, the account address, and a chain-read amount. NOTHING originates from model text.
 *
 *   1. approve(router, amountIn)            EXACT amount, spender = the chain's SwapRouter02 only.
 *   2. router.exactInputSingle(...)         tokenOut = the chain's WETH9, recipient = the ACCOUNT
 *                                           (self), amountOutMinimum = 1, sqrtPriceLimitX96 = 0.
 *   3. WETH9.withdraw(wethBalance)          unwraps to NATIVE sent to msg.sender (the account).
 *
 * Pure + deterministic. The result is re-classified (`classifyIntendedCall`) by the runtime
 * before any leg is submitted; the on-chain wall remains the sole enforcement guarantee.
 */

/**
 * amountOutMinimum for the gas swap. 1 = "any non-zero output": a DOCUMENTED unguarded-testnet
 * floor (same precedent as the trader path, which "falls back to minOut = 1" when no band is
 * set). PRODUCTION/MAINNET MUST replace this with a quote- or oracle-derived floor, or a
 * sandwich could take the whole swap. The exposure is bounded on testnet by the exact-amount
 * approve and the small per-chain `gasSwap.tokenAmount`.
 */
export const GAS_SWAP_AMOUNT_OUT_MINIMUM = 1n;

const SWAP_ABI = parseAbi([
  'function approve(address spender, uint256 amount)',
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params)',
  'function withdraw(uint256 wad)',
]);

export interface GasSwapCall {
  /** what the leg is, for the trace / failure narration */
  leg: 'approve' | 'swap' | 'unwrap';
  target: Address;
  value: bigint;
  data: Hex;
}

export interface GasSwapParams {
  /** the account (LeashAccount) — the swap recipient (pinned self). */
  self: Address;
  /** the spendable token being sold. */
  token: Address;
  /** the chain's Uniswap V3 SwapRouter02. */
  router: Address;
  /** the chain's WETH9 (swap output + unwrap target). */
  wrappedNative: Address;
  /** the pool fee tier (config), e.g. 3000. */
  feeTier: number;
  /** server-computed: min(spendable token balance, cfg.gasSwap.tokenAmount). */
  amountIn: bigint;
}

/** Legs 1 + 2: the exact-amount approve and the router swap. */
export function buildGasSwapCalls(p: GasSwapParams): { approve: GasSwapCall; swap: GasSwapCall } {
  const approve: GasSwapCall = {
    leg: 'approve',
    target: p.token,
    value: 0n,
    data: encodeFunctionData({ abi: SWAP_ABI, functionName: 'approve', args: [p.router, p.amountIn] }),
  };
  const swap: GasSwapCall = {
    leg: 'swap',
    target: p.router,
    value: 0n,
    data: encodeFunctionData({
      abi: SWAP_ABI,
      functionName: 'exactInputSingle',
      args: [
        {
          tokenIn: p.token,
          tokenOut: p.wrappedNative,
          fee: p.feeTier,
          recipient: p.self,
          amountIn: p.amountIn,
          amountOutMinimum: GAS_SWAP_AMOUNT_OUT_MINIMUM,
          sqrtPriceLimitX96: 0n,
        },
      ],
    }),
  };
  return { approve, swap };
}

/** Leg 3: unwrap `wethAmount` (the account's WETH balance read AFTER the swap) to native. */
export function buildWrappedNativeUnwrap(wrappedNative: Address, wethAmount: bigint): GasSwapCall {
  return {
    leg: 'unwrap',
    target: wrappedNative,
    value: 0n,
    data: encodeFunctionData({ abi: SWAP_ABI, functionName: 'withdraw', args: [wethAmount] }),
  };
}
