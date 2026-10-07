import type { Pool } from 'pg';
import type { AgentRow, AgentStatus, GatewayRule, AgentGoal } from '../types.js';

interface DbAgentRow {
  id: string;
  chain_agent_id: string | null;
  chain_id: string;
  owner_addr: string;
  account_addr: string | null;
  session_key_addr: string | null;
  session_key_enc: string | null;
  audit_pubkey: string | null;
  token_id: string;
  token_hash: string;
  name: string;
  status: AgentStatus;
  gateway_rules: GatewayRule[];
  goal: AgentGoal;
  encrypted_audit_key: string | null;
  gateway_token_enc: string | null;
  guardian_addr: string | null;
  capability_label: string | null;
  account_version: number;
  account_salt: string | null;
  account_create_tuple: Record<string, unknown> | null;
  bind_mode: 'external' | null;
  created_at: Date;
}

function mapRow(r: DbAgentRow): AgentRow {
  return {
    id: r.id,
    chainAgentId: r.chain_agent_id,
    chainId: Number(r.chain_id),
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
    guardianAddr: r.guardian_addr,
    capabilityLabel: r.capability_label,
    accountVersion: r.account_version,
    accountSalt: r.account_salt,
    accountCreateTuple: r.account_create_tuple,
    bindMode: r.bind_mode,
    createdAt: r.created_at.toISOString(),
  };
}

const COLS = `id, chain_agent_id, chain_id, owner_addr, account_addr, session_key_addr, session_key_enc,
  audit_pubkey, token_id, token_hash, name, status, gateway_rules, goal, encrypted_audit_key,
  gateway_token_enc, guardian_addr, capability_label, account_version, account_salt, account_create_tuple,
  bind_mode, created_at`;

export async function getAgentById(pool: Pool, id: string): Promise<AgentRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const res = await pool.query<DbAgentRow>(`SELECT ${COLS} FROM agents WHERE id = $1`, [id]);
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

export async function getAgentByTokenId(pool: Pool, tokenId: string): Promise<AgentRow | null> {
  const res = await pool.query<DbAgentRow>(`SELECT ${COLS} FROM agents WHERE token_id = $1`, [tokenId]);
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

/**
 * SE-5/SE-6 (E-5 + the SE-6 pre-req): resolve an agent by its OWNER-scoped
 * (chainId, account) key. Under SE-6 CREATE2 the SAME account address can exist
 * on multiple chains — AND two DIFFERENT owners can deterministically share an
 * address on the same chain — so the read is scoped by owner_addr as well: one
 * owner can never resolve (or cross-read) another owner's agent through a shared
 * address. Migration 021's UNIQUE(owner_addr, chain_id, account_addr) makes the
 * key single-row by construction; the >1 guard below asserts that invariant
 * instead of silently picking a row (the old ORDER BY … LIMIT 1 is gone).
 */
export async function getAgentByAccountAndChain(
  pool: Pool,
  ownerAddr: string,
  chainId: number,
  accountAddr: string,
): Promise<AgentRow | null> {
  const res = await pool.query<DbAgentRow>(
    `SELECT ${COLS} FROM agents WHERE owner_addr = $1 AND chain_id = $2 AND account_addr = $3`,
    [ownerAddr.toLowerCase(), chainId, accountAddr.toLowerCase()],
  );
  if (res.rows.length > 1) {
    // Unreachable behind agents_owner_chain_account — a hit means the DB invariant
    // itself is broken; refuse loudly rather than arbitrarily picking a row.
    throw new Error(
      `integrity violation: ${res.rows.length} agents share (owner, chain ${chainId}, account ${accountAddr.toLowerCase()})`,
    );
  }
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

export interface InsertAgentInput {
  chainAgentId: bigint;
  /** SE-5: the chain this agent's account lives on — the (chainId, account) anchor. */
  chainId: number;
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
  /** Guardian address the account was created with (C-1). */
  guardianAddr: string;
  /** Phase-5 (D-B9): optional freeform capability label; null when unset. */
  capabilityLabel?: string | null;
  /** SE-1 (Stage E): on-chain account version (2 legacy | 4 governed-calldata). */
  accountVersion: 2 | 4;
  /**
   * SE-6: the per-agent CREATE2 salt (0x-prefixed bytes32, server-generated at a
   * deterministic v4 create; reused verbatim on every chain the agent onboards so
   * the account lands at the SAME address). Null for legacy / non-deterministic mints.
   */
  accountSalt?: string | null;
  /**
   * SE-6 (W2): the EXACT canonical construction tuple the v4 mint used —
   * replayed verbatim at a later chain onboard (it is baked into the CREATE2
   * initcode; a reconstructed tuple would predict a different address).
   */
  accountCreateTuple?: Record<string, unknown> | null;
}

export async function insertAgent(pool: Pool, input: InsertAgentInput): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO agents (chain_agent_id, chain_id, owner_addr, account_addr, session_key_addr, session_key_enc,
                         audit_pubkey, token_id, token_hash, name, gateway_rules, goal, encrypted_audit_key,
                         gateway_token_enc, guardian_addr, capability_label, account_version, account_salt, account_create_tuple)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
    [
      input.chainAgentId.toString(),
      input.chainId,
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
      input.guardianAddr.toLowerCase(),
      input.capabilityLabel ?? null,
      input.accountVersion,
      input.accountSalt?.toLowerCase() ?? null,
      input.accountCreateTuple ? JSON.stringify(input.accountCreateTuple) : null,
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('agent insert failed');
  return row.id;
}

export interface InsertBoundAgentRowInput {
  ownerAddr: string;
  name: string;
  tokenId: string;
  tokenHash: string;
  /** agents.chain_id is NOT NULL; 0 = off-chain bound (no home chain), else the referenced account's chain. */
  chainId: number;
  gatewayRules: GatewayRule[];
}

/**
 * SF-2: insert an EXTERNAL bound agent's `agents` row — the same spine row a
 * native agent gets, minus the on-chain authority columns it legitimately lacks
 * (session key, audit key, chain-agent id, account). bind_mode='external' marks
 * it; account_version defaults to the (inert) legacy 2. The runtime can never
 * start it (no session key → F-2b), so no decrypt path ever touches the nulls.
 */
export async function insertBoundAgentRow(pool: Pool, input: InsertBoundAgentRowInput): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO agents (chain_id, owner_addr, token_id, token_hash, name, gateway_rules, goal, bind_mode)
     VALUES ($1,$2,$3,$4,$5,$6,'{}'::jsonb,'external') RETURNING id`,
    [input.chainId, input.ownerAddr.toLowerCase(), input.tokenId, input.tokenHash, input.name, JSON.stringify(input.gatewayRules)],
  );
  const row = res.rows[0];
  if (!row) throw new Error('bound agent insert failed');
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
  // SF-2 (F-2b): the runtime only ever runs NATIVE agents. An external bound
  // agent has no session key, so it has no sense→decide→act loop to run —
  // exclude it here by construction (belt-and-braces with POST /start's reject).
  const res = await pool.query<DbAgentRow>(
    `SELECT ${COLS} FROM agents WHERE status = 'active' AND bind_mode IS DISTINCT FROM 'external'`,
  );
  return res.rows.map(mapRow);
}

export interface ListAgentsByOwnerOptions {
  /** Keyset cursor `<createdAtISO>_<id>` from a previous page. */
  cursor?: string;
  limit?: number;
}

/**
 * Fleet list (spec §4 GET /api/agents): the owner's agents newest-first,
 * keyset-paginated on (created_at, id) — stable under concurrent creates,
 * unlike offset paging (pagination-from-day-one, spec §11).
 */
export async function listAgentsByOwner(
  pool: Pool,
  ownerAddr: string,
  opts: ListAgentsByOwnerOptions = {},
): Promise<{ agents: AgentRow[]; nextCursor?: string }> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const params: unknown[] = [ownerAddr.toLowerCase()];
  let where = `owner_addr = $1`;
  const cursor = opts.cursor !== undefined ? parseAgentCursor(opts.cursor) : null;
  if (cursor) {
    params.push(cursor.createdAt, cursor.id);
    // ms-truncated on BOTH sides: the cursor round-trips through a JS Date
    // (ms precision) — comparing it against the µs-precise column would skip
    // rows sharing the boundary millisecond. Order and compare the same key.
    where += ` AND (date_trunc('milliseconds', created_at), id) < ($2::timestamptz, $3::uuid)`;
  }
  params.push(limit + 1);
  const res = await pool.query<DbAgentRow>(
    `SELECT ${COLS} FROM agents WHERE ${where}
     ORDER BY date_trunc('milliseconds', created_at) DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  const page = res.rows.slice(0, limit).map(mapRow);
  const last = page[page.length - 1];
  return {
    agents: page,
    ...(res.rows.length > limit && last ? { nextCursor: `${last.createdAt}_${last.id}` } : {}),
  };
}

function parseAgentCursor(raw: string): { createdAt: string; id: string } | null {
  const sep = raw.lastIndexOf('_');
  if (sep <= 0) return null;
  const createdAt = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  if (Number.isNaN(Date.parse(createdAt)) || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return { createdAt, id };
}

/** Replace gateway_rules wholesale (PATCH /api/agents/:id/rules — traced 'config' by the route). */
export async function updateAgentRules(pool: Pool, id: string, rules: GatewayRule[]): Promise<void> {
  await pool.query(`UPDATE agents SET gateway_rules = $2 WHERE id = $1`, [id, JSON.stringify(rules)]);
}

/**
 * Phase-5.5: replace the agent's goal JSONB wholesale (owner-authored, applied by
 * the runtime `sense_direction` step or the confirm route). The caller has ALREADY
 * validated the new goal through the R-1 generality guard (applyGoalPatch) — this
 * is the persistence primitive only. A running loop caches `goal` at start(); the
 * cycle-boundary `sense_direction` step mutates its in-memory copy alongside this.
 */
export async function updateAgentGoal(pool: Pool, id: string, goal: AgentGoal): Promise<void> {
  await pool.query(`UPDATE agents SET goal = $2 WHERE id = $1`, [id, JSON.stringify(goal)]);
}

/** C-1 quota: ALL created rows count, incl. revoked (no quota refill by revoking). */
export async function countAgentsByOwner(pool: Pool, ownerAddr: string): Promise<number> {
  const res = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM agents WHERE owner_addr = $1`, [
    ownerAddr.toLowerCase(),
  ]);
  return Number(res.rows[0]?.n ?? 0);
}

/**
 * C-1 rate limit (5/h default): durable sliding window over agents.created_at
 * — restart-proof, unlike an in-memory token bucket. Returns how many seconds
 * until the oldest in-window create ages out (the Retry-After hint), or null
 * when under the limit.
 */
export async function createRateRetryAfter(
  pool: Pool,
  ownerAddr: string,
  perHour: number,
): Promise<number | null> {
  const res = await pool.query<{ created_at: Date }>(
    `SELECT created_at FROM agents
     WHERE owner_addr = $1 AND created_at > now() - interval '1 hour'
     ORDER BY created_at ASC`,
    [ownerAddr.toLowerCase()],
  );
  if (res.rowCount === null || res.rowCount < perHour) return null;
  const oldest = res.rows[0];
  if (!oldest) return null;
  const agesOutMs = oldest.created_at.getTime() + 3_600_000 - Date.now();
  return Math.max(1, Math.ceil(agesOutMs / 1000));
}

/** Startup backfill (S7): legacy rows get the ops-key guardian recorded explicitly. */
export async function backfillLegacyGuardian(pool: Pool, opsAddr: string): Promise<number> {
  const res = await pool.query(`UPDATE agents SET guardian_addr = $1 WHERE guardian_addr IS NULL`, [
    opsAddr.toLowerCase(),
  ]);
  return res.rowCount ?? 0;
}

/** M-03: resync the stored guardian to the live on-chain value (revoke lane selection). */
export async function updateAgentGuardian(pool: Pool, id: string, guardianAddr: string): Promise<void> {
  await pool.query(`UPDATE agents SET guardian_addr = $2 WHERE id = $1`, [id, guardianAddr.toLowerCase()]);
}
