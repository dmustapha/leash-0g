// F-2: an underfunded ops wallet surfaced as an opaque 500 "internal error".
// isInsufficientFunds is the classifier that routes it to a clear 409.
import { describe, it, expect } from 'vitest';
import { isInsufficientFunds } from '../../src/api/owner-routes.js';

describe('isInsufficientFunds (F-2)', () => {
  it('matches the viem top-level message', () => {
    expect(isInsufficientFunds(new Error('insufficient funds for gas * price + value'))).toBe(true);
  });

  it('matches a node phrasing in error.details', () => {
    const err = new Error('transaction failed');
    (err as Error & { details: string }).details = 'insufficient balance for transfer';
    expect(isInsufficientFunds(err)).toBe(true);
  });

  it('walks the cause chain (viem wraps node errors)', () => {
    const inner = new Error('insufficient funds for gas * price + value: have 0 want 2000000000000000');
    const outer = new Error('failed to send transaction');
    (outer as Error & { cause: unknown }).cause = inner;
    expect(isInsufficientFunds(outer)).toBe(true);
  });

  it('matches the InsufficientFundsError name', () => {
    const err = new Error('The total cost of executing this transaction exceeds the balance of the account.');
    err.name = 'InsufficientFundsError';
    expect(isInsufficientFunds(err)).toBe(true);
  });

  it('does NOT match unrelated errors or a self-referencing cause chain', () => {
    expect(isInsufficientFunds(new Error('execution reverted: OverPerTransferCap'))).toBe(false);
    expect(isInsufficientFunds('insufficient funds')).toBe(false); // non-Error stays opaque
    const loop = new Error('nope');
    (loop as Error & { cause: unknown }).cause = loop;
    expect(isInsufficientFunds(loop)).toBe(false); // bounded walk terminates
  });
});
