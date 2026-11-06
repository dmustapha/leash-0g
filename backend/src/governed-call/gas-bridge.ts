import { encodeFunctionData, pad, parseAbi, type Address, type Hex } from 'viem';

/**
 * AQ-FND M-3 inc-3b S1 — the CCTP v2 bridge call builder (USDC burn on the source chain; the
 * mint on the destination is a separate, permissionless `receiveMessage`, see the RailDriver).
 *
 * Every argument is server-determined (owner config rail address, the planner's lane, the
 * account address, a chain-read amount). Nothing originates from model text.
 *
 *   1. approve(tokenMessenger, amount)        EXACT amount, spender = the configured rail only.
 *   2. depositForBurn(amount, domain,
 *        mintRecipient = SELF (bytes32),
 *        burnToken, destinationCaller = 0,    permissionless far-chain mint (any relayer may fill)
 *        maxFee, minFinalityThreshold)
 *
 * Pure + deterministic; the result is re-classified (decodeCall/classify) by the runtime before
 * submission. The on-chain wall remains the sole enforcement guarantee.
 */

/** CCTP v2: 2000 = standard (finalized) transfer, 1000 = fast. Standard has a zero fee. */
export const CCTP_STANDARD_FINALITY = 2000;

const ZERO_BYTES32: Hex = `0x${'00'.repeat(32)}`;

const BRIDGE_ABI = parseAbi([
  'function approve(address spender, uint256 amount)',
  'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)',
]);

export interface BridgeCall {
  leg: 'approve' | 'burn';
  target: Address;
  value: bigint;
  data: Hex;
}

export interface CctpBurnParams {
  /** the account (LeashAccount) on the source chain — also the far-chain mint recipient (same-address). */
  self: Address;
  /** the chain's CCTP TokenMessengerV2 (owner config). */
  tokenMessenger: Address;
  /** USDC on the source chain. */
  burnToken: Address;
  /** Circle domain id of the destination (rail-domains.ts CCTP_DOMAIN_TO_CHAIN). */
  destinationDomain: number;
  /** server-computed: min(spendable USDC, configured bridge amount). */
  amount: bigint;
  /** relayer fee ceiling; must be <= amount. Default 0 (standard transfers charge none). */
  maxFee?: bigint;
  minFinalityThreshold?: number;
}

export function buildCctpBurnCalls(p: CctpBurnParams): { approve: BridgeCall; burn: BridgeCall } {
  const maxFee = p.maxFee ?? 0n;
  if (p.amount <= 0n) throw new Error('cctp burn amount must be positive');
  if (maxFee > p.amount) throw new Error('cctp maxFee exceeds amount');
  if (!Number.isInteger(p.destinationDomain) || p.destinationDomain < 0) throw new Error('bad cctp domain');
  const approve: BridgeCall = {
    leg: 'approve',
    target: p.burnToken,
    value: 0n,
    data: encodeFunctionData({ abi: BRIDGE_ABI, functionName: 'approve', args: [p.tokenMessenger, p.amount] }),
  };
  const burn: BridgeCall = {
    leg: 'burn',
    target: p.tokenMessenger,
    value: 0n,
    data: encodeFunctionData({
      abi: BRIDGE_ABI,
      functionName: 'depositForBurn',
      args: [
        p.amount,
        p.destinationDomain,
        pad(p.self, { size: 32 }),
        p.burnToken,
        ZERO_BYTES32,
        maxFee,
        p.minFinalityThreshold ?? CCTP_STANDARD_FINALITY,
      ],
    }),
  };
  return { approve, burn };
}
