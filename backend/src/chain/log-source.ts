import { parseAbiItem, type Hex, type PublicClient } from 'viem';
import type { RevokedLogSource } from './revoke-watcher.js';

const revokedEvent = parseAbiItem('event Revoked(address indexed by)');

// F-1: the 0G RPC caps eth_getLogs address filters at 32 addresses — one
// filter carrying the whole fleet (37+) fails EVERY tick (InvalidInputRpcError),
// leaving the on-chain revoke escape hatch unobserved fleet-wide.
const MAX_ADDRESSES_PER_FILTER = 32;

/** Viem-backed Revoked-event source for the poll watcher (spec §3b path b). */
export function viemRevokedLogSource(client: PublicClient): RevokedLogSource {
  return {
    getBlockNumber: () => client.getBlockNumber(),
    async getRevokedAccounts(fromBlock: bigint, toBlock: bigint, accounts: string[]): Promise<string[]> {
      if (accounts.length === 0) return [];
      const normalized = accounts.map((a) => a.toLowerCase() as Hex);
      const chunks: Hex[][] = [];
      for (let i = 0; i < normalized.length; i += MAX_ADDRESSES_PER_FILTER) {
        chunks.push(normalized.slice(i, i + MAX_ADDRESSES_PER_FILTER));
      }
      const results = await Promise.all(
        chunks.map((chunk) =>
          client.getLogs({
            address: chunk,
            event: revokedEvent,
            fromBlock: fromBlock + 1n, // interval contract: (fromBlock, toBlock]
            toBlock,
          }),
        ),
      );
      return [...new Set(results.flat().map((l) => l.address.toLowerCase()))];
    },
  };
}
