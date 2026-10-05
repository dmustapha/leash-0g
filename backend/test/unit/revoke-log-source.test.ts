import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { viemRevokedLogSource } from '../../src/chain/log-source.js';

function addr(i: number): string {
  return `0x${i.toString(16).padStart(40, '0')}`;
}

describe('viemRevokedLogSource (F-1: ≤32 addresses per eth_getLogs filter)', () => {
  function fakeClient(revokedAt: string[]) {
    const calls: string[][] = [];
    const ranges: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
    const client = {
      getBlockNumber: () => Promise.resolve(100n),
      getLogs: (args: { address: string[]; fromBlock: bigint; toBlock: bigint }) => {
        calls.push(args.address);
        ranges.push({ fromBlock: args.fromBlock, toBlock: args.toBlock });
        const hits = args.address.filter((a) => revokedAt.includes(a.toLowerCase()));
        return Promise.resolve(hits.map((a) => ({ address: a })));
      },
    };
    return { calls, ranges, client: client as unknown as PublicClient };
  }

  it('splits a 37-account fleet into 32+5 and merges results', async () => {
    const accounts = Array.from({ length: 37 }, (_, i) => addr(i + 1));
    const revoked = [addr(3), addr(36)]; // one in each chunk
    const { calls, ranges, client } = fakeClient(revoked);
    const source = viemRevokedLogSource(client);

    const result = await source.getRevokedAccounts(90n, 100n, accounts);

    expect(calls.map((c) => c.length)).toEqual([32, 5]);
    expect(result.sort()).toEqual(revoked.sort());
    // interval contract: (fromBlock, toBlock] — every chunk queries the same window
    expect(ranges).toEqual([
      { fromBlock: 91n, toBlock: 100n },
      { fromBlock: 91n, toBlock: 100n },
    ]);
  });

  it('normalizes mixed-case input addresses before filtering', async () => {
    const mixed = addr(1).replace('0x0', '0x0').toUpperCase().replace('0X', '0x');
    const { calls, client } = fakeClient([addr(1)]);
    const result = await viemRevokedLogSource(client).getRevokedAccounts(90n, 100n, [mixed]);
    expect(calls[0]).toEqual([addr(1)]);
    expect(result).toEqual([addr(1)]);
  });

  it('returns [] without any RPC call for an empty fleet', async () => {
    const { calls, client } = fakeClient([]);
    const result = await viemRevokedLogSource(client).getRevokedAccounts(90n, 100n, []);
    expect(result).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('keeps a ≤32 fleet on a single call', async () => {
    const accounts = Array.from({ length: 32 }, (_, i) => addr(i + 1));
    const { calls, client } = fakeClient([]);
    await viemRevokedLogSource(client).getRevokedAccounts(90n, 100n, accounts);
    expect(calls.map((c) => c.length)).toEqual([32]);
  });

  it('dedupes an account revoked-logged twice across the window', async () => {
    const doubleLogClient = {
      getBlockNumber: () => Promise.resolve(100n),
      getLogs: () => Promise.resolve([{ address: addr(1) }, { address: addr(1) }]),
    } as unknown as PublicClient;
    const result = await viemRevokedLogSource(doubleLogClient).getRevokedAccounts(90n, 100n, [addr(1)]);
    expect(result).toEqual([addr(1)]);
  });
});
