import type { Pool } from 'pg';

/**
 * AQ-FND S1: owner-facing view of a blocked send key. A key is blocked when one of an agent's transactions
 * could not be resolved automatically (`needs_review`): the lane refuses further sends so nothing can be paid
 * twice. The OWNER can look at it and clear it once they have checked the chain.
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

/**
 * The owner confirms they reviewed the transaction. The blocked row is retired (`superseded`) so the key can send again.
 * Safe: a needs_review row only exists once its nonce is consumed or its bytes can no longer be sent, so clearing it
 * cannot cause a duplicate of THAT transaction; the next send takes a fresh nonce from the chain.
 */
export async function clearSendBlock(pool: Pool, agentId: string): Promise<number> {
  const r = await pool.query(
    `UPDATE tx_intents SET status = 'superseded', error_text = coalesce(error_text, '') || ' [cleared by the owner after review]', updated_at = now() WHERE agent_id = $1 AND status = 'needs_review'`,
    [agentId],
  );
  return r.rowCount ?? 0;
}
