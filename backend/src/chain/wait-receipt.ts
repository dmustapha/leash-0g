import type { PublicClient, TransactionReceipt, Hex } from 'viem';
import { TransactionReceiptNotFoundError, WaitForTransactionReceiptTimeoutError } from 'viem';

/**
 * 0G quirk (observed live from Render, 2026-09-20): block numbers advance
 * before receipts become queryable, so viem's waitForTransactionReceipt can
 * throw TransactionReceiptNotFoundError for a tx that lands moments later.
 * Retry the whole wait a few times before giving up.
 */
export async function waitReceipt(
  client: PublicClient,
  hash: Hex,
  attempts = 4,
): Promise<TransactionReceipt> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await client.waitForTransactionReceipt({ hash, timeout: 45_000, retryCount: 8, retryDelay: 1_500 });
    } catch (err) {
      lastErr = err;
      const retryable =
        err instanceof TransactionReceiptNotFoundError ||
        err instanceof WaitForTransactionReceiptTimeoutError;
      if (!retryable) throw err;
      await new Promise((r) => setTimeout(r, 2_000 * (i + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
