import { describe, it, expect } from 'vitest';
import { TransactionReceiptNotFoundError } from 'viem';
import type { PublicClient } from 'viem';
import { waitReceipt, ReceiptUnconfirmedError } from '../../src/chain/wait-receipt.js';

const HASH = `0x${'ab'.repeat(32)}` as const;

function clientThatFailsTimes(n: number): { client: PublicClient; calls: () => number } {
  let calls = 0;
  const client = {
    waitForTransactionReceipt: () => {
      calls++;
      if (calls <= n) return Promise.reject(new TransactionReceiptNotFoundError({ hash: HASH }));
      return Promise.resolve({ status: 'success', transactionHash: HASH });
    },
  } as unknown as PublicClient;
  return { client, calls: () => calls };
}

function clientThatAlwaysThrows(err: Error): { client: PublicClient; calls: () => number } {
  let calls = 0;
  const client = {
    waitForTransactionReceipt: () => {
      calls++;
      return Promise.reject(err);
    },
  } as unknown as PublicClient;
  return { client, calls: () => calls };
}

describe('waitReceipt (0G receipt-lag retry)', () => {
  it('retries TransactionReceiptNotFoundError and returns the eventual receipt', async () => {
    const { client, calls } = clientThatFailsTimes(2);
    const receipt = await waitReceipt(client, HASH);
    expect(receipt.status).toBe('success');
    expect(calls()).toBe(3);
  });

  // Was: "gives up ... with the underlying error". The underlying error reads as a
  // FAILURE to every caller, and a caller that already moved value then books a
  // paid tx as failed. Exhaustion means UNRESOLVED, and the hash must survive it.
  it('gives up with a typed ReceiptUnconfirmedError that carries the hash', async () => {
    const { client, calls } = clientThatFailsTimes(99);
    const err = await waitReceipt(client, HASH, 2).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReceiptUnconfirmedError);
    const unconfirmed = err as ReceiptUnconfirmedError;
    expect(unconfirmed.hash).toBe(HASH);
    expect(unconfirmed.attempts).toBe(2);
    expect(unconfirmed.quirk).toBe(true);
    expect(unconfirmed.cause).toBeInstanceOf(TransactionReceiptNotFoundError);
    expect(calls()).toBe(2);
  });

  // Was: "does not retry non-retryable errors". Inverted deliberately — receipt
  // lookup is an idempotent read, so there is no such thing as a non-retryable
  // error here, and the old denylist was the mechanism by which a transient RPC
  // fault on an UNRELATED concern (`nonce too low` is a send-time error) threw a
  // live tx hash away on the first attempt.
  it('retries an error with no 0G-lag signature instead of rethrowing it', async () => {
    const { client, calls } = clientThatAlwaysThrows(new Error('nonce too low'));
    const err = await waitReceipt(client, HASH, 2).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReceiptUnconfirmedError);
    expect((err as ReceiptUnconfirmedError).quirk).toBe(false);
    expect(calls()).toBe(2);
  });

  it('flags an RPC -32000 as the 0G lag quirk', async () => {
    const { client } = clientThatAlwaysThrows(new Error('server error: -32000 transaction not found'));
    const err = await waitReceipt(client, HASH, 1).catch((e: unknown) => e);
    expect((err as ReceiptUnconfirmedError).quirk).toBe(true);
  });

  it('does not sleep after the final attempt', async () => {
    // attempts=1 means one failure and zero backoff: the whole call must settle
    // well inside the 2s the old loop burned before returning.
    const { client } = clientThatAlwaysThrows(new Error('boom'));
    const started = process.hrtime.bigint();
    await waitReceipt(client, HASH, 1).catch(() => undefined);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeLessThan(500);
  });
});
