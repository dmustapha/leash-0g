/**
 * Typed errors of the intent ledger / send lane. Callers (graph nodes) map these to outcomes:
 *   TxInFlightError    -> "a previous action is still confirming" (stand down, NEVER a retry)
 *   TxNeedsReviewError -> the key's nonce was consumed by an unknown tx; a human decides
 * A null/slow receipt is signalled with the existing `ReceiptUnconfirmedError` (chain/wait-receipt.ts)
 * so every existing handler keeps treating it as "unknown", not "failed".
 */
export class TxInFlightError extends Error {
  readonly intentId: string | null;
  constructor(intentId: string | null, message = 'a previous transaction from this key is still confirming') {
    super(message);
    this.name = 'TxInFlightError';
    this.intentId = intentId;
  }
}

export class TxNeedsReviewError extends Error {
  readonly intentId: string;
  readonly reason: string;
  constructor(intentId: string, reason?: string | null) {
    const why = reason && reason.length > 0 ? reason : 'a transaction could not be resolved automatically';
    super(`sending is blocked until a human reviews it: ${why}`);
    this.reason = why;
    this.name = 'TxNeedsReviewError';
    this.intentId = intentId;
  }
}

export type TxErrorClass = 'permanent' | 'transient' | 'ambiguous';
