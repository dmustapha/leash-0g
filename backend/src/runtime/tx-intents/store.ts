import type { Pool } from 'pg';

/**
 * AQ-FND S1: owner-facing view of a blocked send key. A key is blocked when one of an agent's transactions
 * could not be resolved automatically (`needs_review`): the lane refuses further sends so nothing can be paid
 * twice. Resolving it is NOT a plain SQL update (that could unlock a second payment): see SendLane.clearReview/cancelBlocked.
 */
export interface SendBlock {
  intentId: string;
  reason: string;
  txHash: string | null;
  chainId: number;
}

export async function getSendBlock(pool: Pool, agentId: string): Promise<SendBlock | null> {
  const { rows } = await pool.query<{ intent_id: string; error_text: string | null; tx_hash: string | null; chain_id: number }>(
    `SELECT intent_id, error_text, tx_hash, chain_id FROM tx_intents WHERE agent_id = $1 AND status = 'needs_review' ORDER BY updated_at DESC LIMIT 1`,
    [agentId],
  );
  const r = rows[0];
  return r ? { intentId: r.intent_id, reason: r.error_text ?? 'a transaction could not be resolved automatically', txHash: r.tx_hash, chainId: r.chain_id } : null;
}
