import type { PublicClient, TransactionReceipt, Hex } from 'viem';
import { TransactionReceiptNotFoundError, WaitForTransactionReceiptTimeoutError } from 'viem';

/**
 * "We do not know" is NOT "it failed".
 *
 * Raised when the receipt for a tx we DID broadcast could not be read inside the
 * attempt budget. The tx may well have landed — the hash is the only handle on it,
 * so it is carried on the error rather than lost in a stack trace. Callers that
 * moved value MUST treat this as unresolved (persist the hash, reconcile later),
 * never as a failure. See `jobs/settlement-sweep.ts` for the reconciler.
 */
export class ReceiptUnconfirmedError extends Error {
  readonly hash: Hex;
  readonly attempts: number;
  /** True when the cause matches the known 0G receipt-indexing lag (§ below). */
  readonly quirk: boolean;

  constructor(input: { hash: Hex; attempts: number; quirk: boolean; cause: unknown }) {
    super(`receipt unconfirmed after ${input.attempts} attempt(s): ${input.hash}`, { cause: input.cause });
    this.name = 'ReceiptUnconfirmedError';
    this.hash = input.hash;
    this.attempts = input.attempts;
    this.quirk = input.quirk;
  }
}

/** The known 0G lag signature. DIAGNOSTIC ONLY — never a retry gate (see below). */
function isZeroGIndexingLag(err: unknown): boolean {
  if (err instanceof TransactionReceiptNotFoundError) return true;
  if (err instanceof WaitForTransactionReceiptTimeoutError) return true;
  return err instanceof Error && err.message.includes('-32000');
}

/**
 * 0G quirk (observed live from Render, 2026-09-20): block numbers advance
 * before receipts become queryable, so viem's waitForTransactionReceipt can
 * throw TransactionReceiptNotFoundError for a tx that lands moments later.
 * Retry the whole wait a few times before giving up.
 *
 * NO RETRY DENYLIST, deliberately. This function performs an idempotent READ of
 * chain state. Classifying an error as "non-retryable" buys nothing on a read —
 * all it can do is convert a transient RPC fault into a tx we stop asking about,
 * which upstream then books as a failure. That is exactly how a paid settlement
 * went missing: a `nonce too low`-shaped error (nothing to do with the receipt)
 * rethrown on the first attempt. The 0G-lag signature is kept, but only to label
 * the log line and set `quirk` — it does not decide whether we retry.
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
      const last = i === attempts - 1;
      console.warn(
        `[waitReceipt] attempt ${i + 1}/${attempts} failed for ${hash}` +
          `${isZeroGIndexingLag(err) ? ' (0G receipt-indexing lag)' : ''}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      // Don't burn the backoff after the final attempt — nothing follows it.
      if (!last) await new Promise((r) => setTimeout(r, 2_000 * (i + 1)));
    }
  }
  throw new ReceiptUnconfirmedError({
    hash,
    attempts,
    quirk: isZeroGIndexingLag(lastErr),
    cause: lastErr,
  });
}
