import { TransactionReceiptNotFoundError, type Hex, type PublicClient } from 'viem';
import type { LaneTransport } from './lane.js';

/**
 * The production `LaneTransport`: a viem PublicClient behind the lane's narrow chain surface.
 * `minFeePerGas` is a per-chain floor (0G enforces a minimum; observed 4 gwei on 2026-11-08, 2 gwei
 * earlier) so a too-cheap tx is never signed in the first place.
 */
export function viemLaneTransport(client: PublicClient, chainId: number, minFeePerGas: bigint = 0n): LaneTransport {
  return {
    chainId,
    getPendingNonce: async (addr) => BigInt(await client.getTransactionCount({ address: addr as Hex, blockTag: 'pending' })),
    getLatestNonce: async (addr) => BigInt(await client.getTransactionCount({ address: addr as Hex, blockTag: 'latest' })),
    estimate: async (req) => ({ gas: await client.estimateGas({ account: req.from, to: req.to, data: req.data, value: req.value }) }),
    feeData: async () => {
      let maxFee = 0n;
      let tip = 0n;
      try {
        const f = await client.estimateFeesPerGas();
        maxFee = f.maxFeePerGas ?? 0n;
        tip = f.maxPriorityFeePerGas ?? 0n;
      } catch {
        maxFee = await client.getGasPrice();
        tip = maxFee;
      }
      if (maxFee < minFeePerGas) maxFee = minFeePerGas;
      if (tip > maxFee) tip = maxFee;
      return { maxFeePerGas: maxFee, maxPriorityFeePerGas: tip };
    },
    sendRaw: async (raw) => client.sendRawTransaction({ serializedTransaction: raw }),
    getReceipt: async (hash) => {
      try {
        const r = await client.getTransactionReceipt({ hash });
        return { status: r.status, blockNumber: r.blockNumber };
      } catch (err) {
        if (err instanceof TransactionReceiptNotFoundError) return null;
        throw err;
      }
    },
    getBlockNumber: async () => client.getBlockNumber(),
  };
}
