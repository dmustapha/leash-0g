import type { Pool } from 'pg';
import type { RevokeCursorStore } from '../chain/revoke-watcher.js';

/**
 * DM-9: durable cursor for the Revoked-event watcher, one row per watched
 * chain. Persisted so a restart resumes from the last fully-scanned block
 * instead of re-seeding to the chain head (which skipped every Revoked emitted
 * while the process was down — a revoked-but-looping fail-open).
 */
export function pgRevokeCursorStore(pool: Pool): RevokeCursorStore {
  return {
    async load(chainId: number): Promise<bigint | null> {
      const res = await pool.query<{ last_block: string }>(
        'SELECT last_block FROM revoke_watcher_cursor WHERE chain_id = $1',
        [chainId],
      );
      const row = res.rows[0];
      return row ? BigInt(row.last_block) : null;
    },
    async save(chainId: number, lastBlock: bigint): Promise<void> {
      await pool.query(
        `INSERT INTO revoke_watcher_cursor (chain_id, last_block, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (chain_id) DO UPDATE SET last_block = EXCLUDED.last_block, updated_at = now()`,
        [chainId, lastBlock.toString()],
      );
    },
  };
}
