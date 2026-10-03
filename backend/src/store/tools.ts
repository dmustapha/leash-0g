import type { Pool } from 'pg';
import type { Json } from '../crypto/canonical.js';
import type { ToolPerCallPolicy, ToolRule, ToolTrigger } from '../tool-use/index.js';

/**
 * Stage F / SF-3 tool-use read-model store (migration 025). DISPLAY + JIT-workflow
 * state ONLY — the gateway egress proxy is the sole authority (no on-chain backstop
 * for an off-chain tool call, §8). Mirror of `store/capabilities.ts`.
 */

// ---------------------------------------------------------------------------
// tool_rules — the owner's standing per-tool grant (server mirror of a ToolRule).
// ---------------------------------------------------------------------------

export type ToolGrantStatus = 'proposed' | 'active' | 'removed';

export interface ToolRuleRow {
  id: string;
  agentId: string;
  chainId: number;
  ownerAddr: string;
  toolId: string;
  allowed: boolean;
  sensitive: boolean;
  perCallPolicy: ToolPerCallPolicy | null;
  source: string;
  status: ToolGrantStatus;
  createdAt: string;
  updatedAt: string;
}

interface DbToolRuleRow {
  id: string;
  agent_id: string;
  chain_id: string;
  owner_addr: string;
  tool_id: string;
  allowed: boolean;
  sensitive: boolean;
  per_call_policy: ToolPerCallPolicy | null;
  source: string;
  status: ToolGrantStatus;
  created_at: Date;
  updated_at: Date;
}

function mapRule(r: DbToolRuleRow): ToolRuleRow {
  return {
    id: r.id,
    agentId: r.agent_id,
    chainId: Number(r.chain_id),
    ownerAddr: r.owner_addr,
    toolId: r.tool_id,
    allowed: r.allowed,
    sensitive: r.sensitive,
    perCallPolicy: r.per_call_policy,
    source: r.source,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export interface UpsertToolRuleInput {
  agentId: string;
  ownerAddr: string;
  rule: ToolRule;
  source: string;
  status: ToolGrantStatus;
}

export async function upsertToolRule(pool: Pool, input: UpsertToolRuleInput): Promise<ToolRuleRow> {
  const { rule } = input;
  const res = await pool.query<DbToolRuleRow>(
    `INSERT INTO tool_rules
       (agent_id, chain_id, owner_addr, tool_id, allowed, sensitive, per_call_policy, source, status)
     VALUES ($1, (SELECT chain_id FROM agents WHERE id = $1), $2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (agent_id, tool_id) DO UPDATE SET
       allowed         = EXCLUDED.allowed,
       sensitive       = EXCLUDED.sensitive,
       per_call_policy = EXCLUDED.per_call_policy,
       source          = EXCLUDED.source,
       status          = EXCLUDED.status,
       updated_at      = now()
     RETURNING *`,
    [
      input.agentId,
      input.ownerAddr.toLowerCase(),
      rule.toolId.toLowerCase(),
      rule.allowed,
      rule.sensitive,
      rule.perCallPolicy ? JSON.stringify(rule.perCallPolicy) : null,
      input.source,
      input.status,
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('tool_rules upsert failed');
  return mapRule(row);
}

export async function setToolRuleStatus(
  pool: Pool,
  agentId: string,
  toolId: string,
  status: ToolGrantStatus,
): Promise<ToolRuleRow | null> {
  const res = await pool.query<DbToolRuleRow>(
    `UPDATE tool_rules SET status = $3, updated_at = now()
     WHERE agent_id = $1 AND tool_id = $2 RETURNING *`,
    [agentId, toolId.toLowerCase(), status],
  );
  return res.rows[0] ? mapRule(res.rows[0]) : null;
}

/** All non-removed tool rules for an agent (the standing grant mirror). */
export async function listToolRules(pool: Pool, agentId: string, includeRemoved = false): Promise<ToolRuleRow[]> {
  const res = await pool.query<DbToolRuleRow>(
    `SELECT * FROM tool_rules WHERE agent_id = $1
       ${includeRemoved ? '' : "AND status <> 'removed'"}
     ORDER BY created_at DESC`,
    [agentId],
  );
  return res.rows.map(mapRule);
}

// ---------------------------------------------------------------------------
// tool_presets — which tool presets an owner applied (display).
// ---------------------------------------------------------------------------

export async function recordToolPresetApplied(
  pool: Pool,
  agentId: string,
  ownerAddr: string,
  presetKey: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO tool_presets (agent_id, chain_id, owner_addr, preset_key)
     VALUES ($1, (SELECT chain_id FROM agents WHERE id = $1), $2, $3)`,
    [agentId, ownerAddr.toLowerCase(), presetKey],
  );
}

export async function listAppliedToolPresets(pool: Pool, agentId: string): Promise<string[]> {
  const res = await pool.query<{ preset_key: string }>(
    `SELECT DISTINCT preset_key FROM tool_presets WHERE agent_id = $1 ORDER BY preset_key`,
    [agentId],
  );
  return res.rows.map((r) => r.preset_key);
}

// ---------------------------------------------------------------------------
// tool_requests — the L2 JIT workflow store (quarantined).
// ---------------------------------------------------------------------------

export type ToolRequestStatus = 'pending' | 'approved_once' | 'always_allowed' | 'denied' | 'expired';

export interface ToolRequestRow {
  id: string;
  agentId: string;
  chainId: number;
  ownerAddr: string;
  toolId: string;
  decoded: Json;
  triggers: ToolTrigger[];
  callHash: string;
  args: Json;
  status: ToolRequestStatus;
  approvalId: string | null;
  createdAt: string;
  decidedAt: string | null;
}

interface DbToolRequestRow {
  id: string;
  agent_id: string;
  chain_id: string;
  owner_addr: string;
  tool_id: string;
  decoded: Json;
  triggers: ToolTrigger[];
  call_hash: string;
  args: Json;
  status: ToolRequestStatus;
  approval_id: string | null;
  created_at: Date;
  decided_at: Date | null;
}

function mapRequest(r: DbToolRequestRow): ToolRequestRow {
  return {
    id: r.id,
    agentId: r.agent_id,
    chainId: Number(r.chain_id),
    ownerAddr: r.owner_addr,
    toolId: r.tool_id,
    decoded: r.decoded,
    triggers: r.triggers,
    callHash: r.call_hash,
    args: r.args,
    status: r.status,
    approvalId: r.approval_id,
    createdAt: r.created_at.toISOString(),
    decidedAt: r.decided_at ? r.decided_at.toISOString() : null,
  };
}

export interface InsertToolRequestInput {
  agentId: string;
  ownerAddr: string;
  toolId: string;
  decoded: Json;
  triggers: ToolTrigger[];
  callHash: string;
  args: Json;
}

/**
 * Insert a pending JIT tool request, idempotent on (agent, call_hash): an
 * identical pending request is reused (`created=false`) so a novel tool call
 * raises exactly ONE card (never a duplicate storm).
 */
export async function insertToolRequest(
  pool: Pool,
  input: InsertToolRequestInput,
): Promise<{ row: ToolRequestRow; created: boolean }> {
  const res = await pool.query<DbToolRequestRow>(
    `INSERT INTO tool_requests (agent_id, chain_id, owner_addr, tool_id, decoded, triggers, call_hash, args)
     VALUES ($1, (SELECT chain_id FROM agents WHERE id = $1), $2,$3,$4,$5,$6,$7)
     ON CONFLICT (agent_id, call_hash) WHERE status = 'pending' DO NOTHING
     RETURNING *`,
    [
      input.agentId,
      input.ownerAddr.toLowerCase(),
      input.toolId.toLowerCase(),
      JSON.stringify(input.decoded),
      JSON.stringify(input.triggers),
      input.callHash,
      JSON.stringify(input.args),
    ],
  );
  if (res.rows[0]) return { row: mapRequest(res.rows[0]), created: true };
  const existing = await pool.query<DbToolRequestRow>(
    `SELECT * FROM tool_requests WHERE agent_id = $1 AND call_hash = $2 AND status = 'pending'`,
    [input.agentId, input.callHash],
  );
  const row = existing.rows[0];
  if (!row) throw new Error('tool_requests insert raced without a pending row');
  return { row: mapRequest(row), created: false };
}

export async function setToolRequestApproval(pool: Pool, id: string, approvalId: string): Promise<void> {
  await pool.query(`UPDATE tool_requests SET approval_id = $2 WHERE id = $1`, [id, approvalId]);
}

export async function getToolRequest(pool: Pool, id: string): Promise<ToolRequestRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const res = await pool.query<DbToolRequestRow>(`SELECT * FROM tool_requests WHERE id = $1`, [id]);
  return res.rows[0] ? mapRequest(res.rows[0]) : null;
}

/** Decide a pending request exactly once; null if already decided (idempotent). */
export async function setToolRequestDecision(
  pool: Pool,
  id: string,
  status: Exclude<ToolRequestStatus, 'pending'>,
): Promise<ToolRequestRow | null> {
  const res = await pool.query<DbToolRequestRow>(
    `UPDATE tool_requests SET status = $2, decided_at = now()
     WHERE id = $1 AND status = 'pending' RETURNING *`,
    [id, status],
  );
  return res.rows[0] ? mapRequest(res.rows[0]) : null;
}

export async function listRecentToolRequests(pool: Pool, agentId: string, limit = 20): Promise<ToolRequestRow[]> {
  const res = await pool.query<DbToolRequestRow>(
    `SELECT * FROM tool_requests WHERE agent_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [agentId, Math.min(Math.max(limit, 1), 100)],
  );
  return res.rows.map(mapRequest);
}
