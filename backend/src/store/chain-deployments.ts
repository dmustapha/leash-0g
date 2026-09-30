import type { Pool } from 'pg';

/**
 * SE-7: per-chain presence rows for an agent's leashed account (migration 023).
 * The agents row is the HOME-chain anchor; each additional chain the agent is
 * onboarded onto (byte-exact tuple replay → SAME address, SD-E9) is one row.
 */

export interface ChainDeploymentRow {
  id: string;
  agentId: string;
  chainId: number;
  accountAddr: string;
  createTx: string;
  registerTx: string;
  chainAgentId: bigint | null;
  adopted: boolean;
  createdAt: string;
}

interface DbRow {
  id: string;
  agent_id: string;
  chain_id: number;
  account_addr: string;
  create_tx: string;
  register_tx: string;
  chain_agent_id: string | null;
  adopted: boolean;
  created_at: string;
}

const COLS = `id, agent_id, chain_id, account_addr, create_tx, register_tx, chain_agent_id, adopted, created_at`;

function mapRow(r: DbRow): ChainDeploymentRow {
  return {
    id: r.id,
    agentId: r.agent_id,
    chainId: r.chain_id,
    accountAddr: r.account_addr,
    createTx: r.create_tx,
    registerTx: r.register_tx,
    chainAgentId: r.chain_agent_id === null ? null : BigInt(r.chain_agent_id),
    adopted: r.adopted,
    createdAt: r.created_at,
  };
}

export async function insertChainDeployment(
  pool: Pool,
  input: {
    agentId: string;
    chainId: number;
    accountAddr: string;
    createTx: string;
    registerTx: string;
    chainAgentId: bigint | null;
    adopted: boolean;
  },
): Promise<ChainDeploymentRow> {
  const res = await pool.query<DbRow>(
    `INSERT INTO agent_chain_deployments (agent_id, chain_id, account_addr, create_tx, register_tx, chain_agent_id, adopted)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLS}`,
    [
      input.agentId,
      input.chainId,
      input.accountAddr.toLowerCase(),
      input.createTx,
      input.registerTx,
      input.chainAgentId === null ? null : input.chainAgentId.toString(),
      input.adopted,
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('insertChainDeployment returned no row');
  return mapRow(row);
}

export async function listChainDeployments(pool: Pool, agentId: string): Promise<ChainDeploymentRow[]> {
  const res = await pool.query<DbRow>(
    `SELECT ${COLS} FROM agent_chain_deployments WHERE agent_id = $1 ORDER BY created_at ASC`,
    [agentId],
  );
  return res.rows.map(mapRow);
}

/**
 * SE-7 (L-04 companion): resolve the OWNER-scoped agent id behind an onboarded
 * (chainId, account) presence row. Scoped by owner via the agents join — one
 * owner can never resolve another owner's agent through a shared CREATE2
 * address (mirrors getAgentByAccountAndChain's posture for home chains).
 */
export async function getOwnedAgentIdByDeployment(
  pool: Pool,
  ownerAddr: string,
  chainId: number,
  accountAddr: string,
): Promise<string | null> {
  const res = await pool.query<{ agent_id: string }>(
    `SELECT d.agent_id FROM agent_chain_deployments d
       JOIN agents a ON a.id = d.agent_id
      WHERE a.owner_addr = $1 AND d.chain_id = $2 AND d.account_addr = $3`,
    [ownerAddr.toLowerCase(), chainId, accountAddr.toLowerCase()],
  );
  if (res.rows.length > 1) {
    throw new Error(
      `integrity violation: ${res.rows.length} deployments share (owner, chain ${chainId}, account ${accountAddr.toLowerCase()})`,
    );
  }
  return res.rows[0]?.agent_id ?? null;
}

export async function getChainDeployment(
  pool: Pool,
  agentId: string,
  chainId: number,
): Promise<ChainDeploymentRow | null> {
  const res = await pool.query<DbRow>(
    `SELECT ${COLS} FROM agent_chain_deployments WHERE agent_id = $1 AND chain_id = $2`,
    [agentId, chainId],
  );
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}
