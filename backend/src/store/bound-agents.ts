import type { Pool, PoolClient } from 'pg';

/**
 * SF-2: the Tier-2-only side-table for an external bound agent. The bound agent
 * itself is an `agents` row (bind_mode='external') so the ENTIRE SF-1/SF-3 spine
 * resolves it unchanged (token → agent, tool_rules FK, traces, approvals); this
 * table carries only what a bound agent adds on top.
 */
export type InteractionMode = 'observe' | 'passive' | 'active';

export interface BoundAgentRow {
  agentId: string;
  leashedAccountAddr: string | null;
  chainId: number | null;
  mcpScope: string[];
  tenantKey: string;
  interactionMode: InteractionMode;
  createdAt: string;
}

interface DbBoundAgentRow {
  agent_id: string;
  leashed_account_addr: string | null;
  chain_id: string | null;
  mcp_scope: string[];
  tenant_key: string;
  interaction_mode: InteractionMode;
  created_at: Date;
}

function mapRow(r: DbBoundAgentRow): BoundAgentRow {
  return {
    agentId: r.agent_id,
    leashedAccountAddr: r.leashed_account_addr,
    chainId: r.chain_id === null ? null : Number(r.chain_id),
    mcpScope: r.mcp_scope,
    tenantKey: r.tenant_key,
    interactionMode: r.interaction_mode,
    createdAt: r.created_at.toISOString(),
  };
}

const COLS = `agent_id, leashed_account_addr, chain_id, mcp_scope, tenant_key, interaction_mode, created_at`;

export interface InsertBoundAgentInput {
  agentId: string;
  leashedAccountAddr?: string | null;
  chainId?: number | null;
  gatewayTokenHash: string;
  mcpScope: string[];
  tenantKey: string;
  interactionMode: InteractionMode;
}

export async function insertBoundAgent(pool: Pool | PoolClient, input: InsertBoundAgentInput): Promise<void> {
  await pool.query(
    `INSERT INTO bound_agents
       (agent_id, leashed_account_addr, chain_id, gateway_token_hash, mcp_scope, tenant_key, interaction_mode)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      input.agentId,
      input.leashedAccountAddr?.toLowerCase() ?? null,
      input.chainId ?? null,
      input.gatewayTokenHash,
      JSON.stringify(input.mcpScope),
      input.tenantKey,
      input.interactionMode,
    ],
  );
}

export async function getBoundAgent(pool: Pool, agentId: string): Promise<BoundAgentRow | null> {
  const res = await pool.query<DbBoundAgentRow>(`SELECT ${COLS} FROM bound_agents WHERE agent_id = $1`, [agentId]);
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

/** Rotate the Tier-2 side-table copy of the gateway-token hash (unbind/rotate). */
export async function updateBoundTokenHash(pool: Pool, agentId: string, gatewayTokenHash: string): Promise<void> {
  await pool.query(`UPDATE bound_agents SET gateway_token_hash = $2 WHERE agent_id = $1`, [agentId, gatewayTokenHash]);
}
