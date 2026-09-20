import { parseAbiItem, type Hex, type PublicClient } from 'viem';
import type { RevokedLogSource } from './revoke-watcher.js';

const revokedEvent = parseAbiItem('event Revoked(address indexed by)');

/** Viem-backed Revoked-event source for the poll watcher (spec §3b path b). */
export function viemRevokedLogSource(client: PublicClient): RevokedLogSource {
  return {
    getBlockNumber: () => client.getBlockNumber(),
    async getRevokedAccounts(fromBlock: bigint, toBlock: bigint, accounts: string[]): Promise<string[]> {
      const logs = await client.getLogs({
        address: accounts as Hex[],
        event: revokedEvent,
        fromBlock: fromBlock + 1n, // interval contract: (fromBlock, toBlock]
        toBlock,
      });
      return [...new Set(logs.map((l) => l.address.toLowerCase()))];
    },
  };
}
