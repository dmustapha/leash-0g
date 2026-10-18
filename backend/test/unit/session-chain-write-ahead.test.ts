// The write-ahead ordering guarantee, asserted on the PRODUCTION call site.
//
// `jobs/graph.ts` only survives an unreadable receipt because the fee-transfer
// hash is persisted BEFORE `waitReceipt` is entered. The integration suite
// asserts that ordering against a FakeChain — which proves the fake, not the
// shipping code. This test holds `SessionChain.executeTokenTransfer` itself to
// it: if someone moves the `onSubmitted` call below the wait, the settlement
// loss class silently reopens and every other test stays green.
import { describe, it, expect, vi } from 'vitest';

const order: string[] = [];
const writeContract = vi.fn(async () => {
  order.push('broadcast');
  return TX;
});

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return { ...actual, createWalletClient: () => ({ chain: undefined, writeContract }) };
});

vi.mock('../../src/chain/wait-receipt.js', () => ({
  waitReceipt: async () => {
    order.push('wait');
    return { status: 'success' as const };
  },
}));

const TX = '0x' + 'ab'.repeat(32);
// Any well-formed 32-byte key; nothing here reaches a network.
const KEY = '0x' + '11'.repeat(32);

const { SessionChain } = await import('../../src/runtime/session-chain.js');

function transfer(onSubmitted?: (h: string) => Promise<void>) {
  const chain = new SessionChain({ rpcUrl: 'http://127.0.0.1:1/unused', chainId: 16601 });
  return chain.executeTokenTransfer({
    sessionPrivateKey: KEY,
    accountAddr: '0x' + '22'.repeat(20),
    token: '0x' + '33'.repeat(20),
    to: '0x' + '44'.repeat(20),
    amountWei: 5_000_000n,
    // Spread, not `onSubmitted,` — under exactOptionalPropertyTypes an explicit
    // `undefined` is not the same as an absent optional property.
    ...(onSubmitted ? { onSubmitted } : {}),
  });
}

describe('SessionChain.executeTokenTransfer write-ahead', () => {
  it('calls onSubmitted with the hash after broadcast and BEFORE the receipt wait', async () => {
    order.length = 0;
    const seen: string[] = [];
    const res = await transfer(async (h) => {
      order.push('onSubmitted');
      seen.push(h);
    });
    expect(order).toEqual(['broadcast', 'onSubmitted', 'wait']);
    expect(seen).toEqual([TX]);
    expect(res.txHash).toBe(TX);
  });

  it('propagates an onSubmitted failure instead of entering the wait', async () => {
    order.length = 0;
    // Not swallowed by design: a caller that cannot persist the hash must not be
    // carried into a wait that can lose it. Loud here is diagnosable.
    await expect(transfer(async () => { throw new Error('db down'); })).rejects.toThrow('db down');
    expect(order).toEqual(['broadcast']);
  });

  it('stays optional — a caller with no onSubmitted still transfers', async () => {
    order.length = 0;
    await expect(transfer()).resolves.toEqual({ txHash: TX });
    expect(order).toEqual(['broadcast', 'wait']);
  });
});
