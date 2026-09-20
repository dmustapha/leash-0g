import type { Pool } from 'pg';
import type { AgentRow, AgentStatus, GatewayRule, AgentGoal } from '../types.js';

interface DbAgentRow {
  id: string;
  chain_agent_id: string | null;
  owner_addr: string;
  account_addr: string;
  session_key_addr: string;
  session_key_enc: string;
  audit_pubkey: string;
  token_id: string;
  token_hash: string;
  name: string;
  status: AgentStatus;
  gateway_rules: GatewayRule[];
  goal: AgentGoal;
  encrypted_audit_key: string | null;
  gateway_token_enc: string | null;
  created_at: Date;
}

function mapRow(r: DbAgentRow): AgentRow {
  return {
    id: r.id,
    chainAgentId: r.chain_agent_id,
    ownerAddr: r.owner_addr,
    accountAddr: r.account_addr,
    sessionKeyAddr: r.session_key_addr,
    sessionKeyEnc: r.session_key_enc,
    auditPubkey: r.audit_pubkey,
    tokenId: r.token_id,
    tokenHash: r.token_hash,
    name: r.name,
    status: r.status,
    gatewayRules: r.gateway_rules,
    goal: r.goal,
    encryptedAuditKey: r.encrypted_audit_key,
    gatewayTokenEnc: r.gateway_token_enc,
    createdAt: r.created_at.toISOString(),
  };
}

const COLS = `id, chain_agent_id, owner_addr, account_addr, session_key_addr, session_key_enc,
  audit_pubkey, token_id, token_hash, name, status, gateway_rules, goal, encrypted_audit_key,
  gateway_token_enc, created_at`;

export async function getAgentById(pool: Pool, id: string): Promise<AgentRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const res = await pool.query<DbAgentRow>(`SELECT ${COLS} FROM agents WHERE id = $1`, [id]);
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

export async function getAgentByTokenId(pool: Pool, tokenId: string): Promise<AgentRow | null> {
  const res = await pool.query<DbAgentRow>(`SELECT ${COLS} FROM agents WHERE token_id = $1`, [tokenId]);
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

export interface InsertAgentInput {
  chainAgentId: bigint;
  ownerAddr: string;
  accountAddr: string;
  sessionKeyAddr: string;
  sessionKeyEnc: string;
  auditPubkey: string;
  tokenId: string;
  tokenHash: string;
  name: string;
  gatewayRules: GatewayRule[];
  goal: AgentGoal;
  encryptedAuditKey?: string;
  gatewayTokenEnc?: string;
}

export async function insertAgent(pool: Pool, input: InsertAgentInput): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO agents (chain_agent_id, owner_addr, account_addr, session_key_addr, session_key_enc,
                         audit_pubkey, token_id, token_hash, name, gateway_rules, goal, encrypted_audit_key,
                         gateway_token_enc)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [
      input.chainAgentId.toString(),
      input.ownerAddr.toLowerCase(),
      input.accountAddr.toLowerCase(),
      input.sessionKeyAddr.toLowerCase(),
      input.sessionKeyEnc,
      input.auditPubkey,
      input.tokenId,
      input.tokenHash,
      input.name,
      JSON.stringify(input.gatewayRules),
      JSON.stringify(input.goal),
      input.encryptedAuditKey ?? null,
      input.gatewayTokenEnc ?? null,
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('agent insert failed');
  return row.id;
}

export async function setAgentStatus(pool: Pool, id: string, status: AgentStatus): Promise<void> {
  await pool.query(`UPDATE agents SET status = $2 WHERE id = $1`, [id, status]);
}

export async function rotateAgentToken(
  pool: Pool,
  id: string,
  tokenId: string,
  tokenHash: string,
  gatewayTokenEnc?: string,
): Promise<void> {
  await pool.query(`UPDATE agents SET token_id = $2, token_hash = $3, gateway_token_enc = $4 WHERE id = $1`, [
    id,
    tokenId,
    tokenHash,
    gatewayTokenEnc ?? null,
  ]);
}

export async function listActiveAgents(pool: Pool): Promise<AgentRow[]> {
  const res = await pool.query<DbAgentRow>(`SELECT ${COLS} FROM agents WHERE status = 'active'`);
  return res.rows.map(mapRow);
}
