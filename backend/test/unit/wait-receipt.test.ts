import { describe, it, expect } from 'vitest';
import { TransactionReceiptNotFoundError } from 'viem';
import type { PublicClient } from 'viem';
import { waitReceipt } from '../../src/chain/wait-receipt.js';

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

describe('waitReceipt (0G receipt-lag retry)', () => {
  it('retries TransactionReceiptNotFoundError and returns the eventual receipt', async () => {
    const { client, calls } = clientThatFailsTimes(2);
    const receipt = await waitReceipt(client, HASH);
    expect(receipt.status).toBe('success');
    expect(calls()).toBe(3);
  });

  it('gives up after the attempt budget with the underlying error', async () => {
    const { client, calls } = clientThatFailsTimes(99);
    await expect(waitReceipt(client, HASH, 2)).rejects.toBeInstanceOf(TransactionReceiptNotFoundError);
    expect(calls()).toBe(2);
  });

  it('does not retry non-retryable errors', async () => {
    let calls = 0;
    const client = {
      waitForTransactionReceipt: () => {
        calls++;
        return Promise.reject(new Error('nonce too low'));
      },
    } as unknown as PublicClient;
    await expect(waitReceipt(client, HASH)).rejects.toThrow('nonce too low');
    expect(calls).toBe(1);
  });
});
