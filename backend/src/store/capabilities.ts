import type { Pool } from 'pg';
import type { Json } from '../crypto/canonical.js';
import type { CallRule, Novelty } from '../governed-call/index.js';

/**
 * Stage D capabilities read-model store (migration 017). DISPLAY + JIT-workflow
 * state ONLY — the on-chain LeashAccountV4 account is the sole authority for
 * enforcement (live-chain-read discipline). Nothing here gates money.
 */

// ---------------------------------------------------------------------------
// capability_grants — a server mirror of an on-chain CallRule (for display).
// ---------------------------------------------------------------------------

export type GrantStatus = 'proposed' | 'active' | 'removed';

export interface GrantRow {
  id: string;
  agentId: string;
  ownerAddr: string;
  target: string;
  selector: string;
  recipientMode: 'self' | 'allowlist';
  spenderSet: string[];
  perCallCap: string;
  windowCapCall: string;
  codehash: string | null;
  source: string;
  status: GrantStatus;
  txHash: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DbGrantRow {
  id: string;
  agent_id: string;
  owner_addr: string;
  target: string;
  selector: string;
  recipient_mode: 'self' | 'allowlist';
  spender_set: string[];
  per_call_cap: string;
  window_cap_call: string;
  codehash: string | null;
  source: string;
  status: GrantStatus;
  tx_hash: string | null;
  created_at: Date;
  updated_at: Date;
}

function mapGrant(r: DbGrantRow): GrantRow {
  return {
    id: r.id,
    agentId: r.agent_id,
    ownerAddr: r.owner_addr,
    target: r.target,
    selector: r.selector,
    recipientMode: r.recipient_mode,
    spenderSet: r.spender_set,
    perCallCap: r.per_call_cap,
    windowCapCall: r.window_cap_call,
    codehash: r.codehash,
    source: r.source,
    status: r.status,
    txHash: r.tx_hash,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export interface UpsertGrantInput {
  agentId: string;
  ownerAddr: string;
  rule: CallRule;
  source: string;
  status: GrantStatus;
  txHash?: string | undefined;
}

/** Insert or update the read-model grant for (agent,target,selector). */
export async function upsertGrant(pool: Pool, input: UpsertGrantInput): Promise<GrantRow> {
  const { rule } = input;
  const res = await pool.query<DbGrantRow>(
    `INSERT INTO capability_grants
       (agent_id, chain_id, owner_addr, target, selector, recipient_mode, spender_set,
        per_call_cap, window_cap_call, codehash, source, status, tx_hash)
     VALUES ($1, (SELECT chain_id FROM agents WHERE id = $1), $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (agent_id, target, selector) DO UPDATE SET
       recipient_mode = EXCLUDED.recipient_mode,
       spender_set    = EXCLUDED.spender_set,
       per_call_cap   = EXCLUDED.per_call_cap,
       window_cap_call= EXCLUDED.window_cap_call,
       codehash       = EXCLUDED.codehash,
       source         = EXCLUDED.source,
       status         = EXCLUDED.status,
       tx_hash        = COALESCE(EXCLUDED.tx_hash, capability_grants.tx_hash),
       updated_at     = now()
     RETURNING *`,
    [
      input.agentId,
      input.ownerAddr.toLowerCase(),
      rule.target.toLowerCase(),
      rule.selector.toLowerCase(),
      rule.recipientMode,
      JSON.stringify(rule.spenderSet.map((s) => s.toLowerCase())),
      rule.perCallCap,
      rule.windowCapCall,
      rule.codehash ? rule.codehash.toLowerCase() : null,
      input.source,
      input.status,
      input.txHash ?? null,
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('capability_grants upsert failed');
  return mapGrant(row);
}

/**
 * Flip a grant's read-model status (e.g. proposed→active on apply, →removed on
 * tighten). DM-1: 'removed' is TERMINAL — a removed grant can never be flipped
 * back to 'active' by a bare status change (that would resurrect a grant the
 * cockpit shows as dead/removed-on-chain). The `status <> 'removed'` from-guard
 * on the active path is the defense-in-depth floor under the route's own guard;
 * re-granting a removed capability must go through a fresh on-chain propose/apply
 * (the upsertGrant txHash path), never here. Returns null when the guard blocks.
 */
export async function setGrantStatus(
  pool: Pool,
  agentId: string,
  target: string,
  selector: string,
  status: GrantStatus,
): Promise<GrantRow | null> {
  const fromGuard = status === 'active' ? " AND status <> 'removed'" : '';
  const res = await pool.query<DbGrantRow>(
    `UPDATE capability_grants SET status = $4, updated_at = now()
     WHERE agent_id = $1 AND target = $2 AND selector = $3${fromGuard} RETURNING *`,
    [agentId, target.toLowerCase(), selector.toLowerCase(), status],
  );
  return res.rows[0] ? mapGrant(res.rows[0]) : null;
}

/** All grants for an agent (display), newest first, excluding removed by default. */
export async function listGrants(pool: Pool, agentId: string, includeRemoved = false): Promise<GrantRow[]> {
  const res = await pool.query<DbGrantRow>(
    `SELECT * FROM capability_grants WHERE agent_id = $1
       ${includeRemoved ? '' : "AND status <> 'removed'"}
     ORDER BY created_at DESC`,
    [agentId],
  );
  return res.rows.map(mapGrant);
}

// ---------------------------------------------------------------------------
// capability_presets — which presets an owner applied to an agent (display).
// ---------------------------------------------------------------------------

export async function recordPresetApplied(
  pool: Pool,
  agentId: string,
  ownerAddr: string,
  presetKey: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO capability_presets (agent_id, chain_id, owner_addr, preset_key)
     VALUES ($1, (SELECT chain_id FROM agents WHERE id = $1), $2, $3)`,
    [agentId, ownerAddr.toLowerCase(), presetKey],
  );
}

export async function listAppliedPresets(pool: Pool, agentId: string): Promise<string[]> {
  const res = await pool.query<{ preset_key: string }>(
    `SELECT DISTINCT preset_key FROM capability_presets WHERE agent_id = $1 ORDER BY preset_key`,
    [agentId],
  );
  return res.rows.map((r) => r.preset_key);
}

// ---------------------------------------------------------------------------
// capability_requests — the L2 JIT workflow store (quarantined).
// ---------------------------------------------------------------------------

export type RequestStatus = 'pending' | 'approved_once' | 'always_allowed' | 'denied' | 'expired';

export type ConsumeStatus = 'consuming' | 'consumed' | 'aborted' | 'failed';

export interface RequestRow {
  id: string;
  agentId: string;
  /** SE-5: the chain this request's account lives on (derived from the agent). */
  chainId: number;
  ownerAddr: string;
  decoded: Json;
  novelty: Novelty[];
  callHash: string;
  status: RequestStatus;
  approvalId: string | null;
  txHash: string | null;
  createdAt: string;
  decidedAt: string | null;
  /** SE-2: the exact refused bytes (server-authored, bound by callHash) for the auto-retry. */
  callTarget: string | null;
  callValue: string | null;
  callData: string | null;
  /** SE-2: the one-shot consumption sub-state (audit trail; on-chain stays authority). */
  consumeStatus: ConsumeStatus | null;
  consumeTxHash: string | null;
}

interface DbRequestRow {
  id: string;
  agent_id: string;
  chain_id: string;
  owner_addr: string;
  decoded: Json;
  novelty: Novelty[];
  call_hash: string;
  status: RequestStatus;
  approval_id: string | null;
  tx_hash: string | null;
  created_at: Date;
  decided_at: Date | null;
  call_target: string | null;
  call_value: string | null;
  call_data: string | null;
  consume_status: ConsumeStatus | null;
  consume_tx_hash: string | null;
}

function mapRequest(r: DbRequestRow): RequestRow {
  return {
    id: r.id,
    agentId: r.agent_id,
    chainId: Number(r.chain_id),
    ownerAddr: r.owner_addr,
    decoded: r.decoded,
    novelty: r.novelty,
    callHash: r.call_hash,
    status: r.status,
    approvalId: r.approval_id,
    txHash: r.tx_hash,
    createdAt: r.created_at.toISOString(),
    decidedAt: r.decided_at ? r.decided_at.toISOString() : null,
    callTarget: r.call_target,
    callValue: r.call_value,
    callData: r.call_data,
    consumeStatus: r.consume_status,
    consumeTxHash: r.consume_tx_hash,
  };
}

export interface InsertRequestInput {
  agentId: string;
  ownerAddr: string;
  decoded: Json;
  novelty: Novelty[];
  callHash: string;
  /** SE-2: the exact refused call bytes to auto-retry after an approve-once (bound by callHash). */
  callTarget: string;
  callValue: string;
  callData: string;
}

/**
 * Insert a pending JIT request, idempotent on (agent, call_hash): if a pending
 * request for the exact call already exists, returns it with `created=false`
 * (a novel call raises exactly ONE request, D-8 — never a duplicate storm).
 */
export async function insertCapabilityRequest(
  pool: Pool,
  input: InsertRequestInput,
): Promise<{ row: RequestRow; created: boolean }> {
  const res = await pool.query<DbRequestRow>(
    `INSERT INTO capability_requests (agent_id, chain_id, owner_addr, decoded, novelty, call_hash, call_target, call_value, call_data)
     VALUES ($1, (SELECT chain_id FROM agents WHERE id = $1), $2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (agent_id, call_hash) WHERE status = 'pending' DO NOTHING
     RETURNING *`,
    [
      input.agentId,
      input.ownerAddr.toLowerCase(),
      JSON.stringify(input.decoded),
      JSON.stringify(input.novelty),
      input.callHash,
      input.callTarget.toLowerCase(),
      input.callValue,
      input.callData,
    ],
  );
  if (res.rows[0]) return { row: mapRequest(res.rows[0]), created: true };
  const existing = await pool.query<DbRequestRow>(
    `SELECT * FROM capability_requests WHERE agent_id = $1 AND call_hash = $2 AND status = 'pending'`,
    [input.agentId, input.callHash],
  );
  const row = existing.rows[0];
  if (!row) throw new Error('capability_requests insert raced without a pending row');
  return { row: mapRequest(row), created: false };
}

/** Bind the approval row that gates a request (set once, right after createApproval). */
export async function setRequestApproval(pool: Pool, id: string, approvalId: string): Promise<void> {
  await pool.query(`UPDATE capability_requests SET approval_id = $2 WHERE id = $1`, [id, approvalId]);
}

export async function getCapabilityRequest(pool: Pool, id: string): Promise<RequestRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const res = await pool.query<DbRequestRow>(`SELECT * FROM capability_requests WHERE id = $1`, [id]);
  return res.rows[0] ? mapRequest(res.rows[0]) : null;
}

/**
 * Decide a pending request exactly once (pending → decided). Returns null if it
 * was already decided/expired (idempotent — a double-tap can't double-grant).
 */
export async function setRequestDecision(
  pool: Pool,
  id: string,
  status: Exclude<RequestStatus, 'pending'>,
  txHash?: string,
): Promise<RequestRow | null> {
  const res = await pool.query<DbRequestRow>(
    `UPDATE capability_requests SET status = $2, tx_hash = $3, decided_at = now()
     WHERE id = $1 AND status = 'pending' RETURNING *`,
    [id, status, txHash ?? null],
  );
  return res.rows[0] ? mapRequest(res.rows[0]) : null;
}

/**
 * SE-2: atomically CLAIM a request for one-shot consumption (pending → consuming).
 * Only an approved_once request that hasn't been consumed/claimed proceeds — the
 * CAS is the off-chain replay guard: a second attempt (or a concurrent retry)
 * gets null (already consuming/consumed/failed) and stands down. An `aborted`
 * request (a prior attempt hit a stale grant) is re-claimable so a later valid
 * trigger can retry; a `failed` one is terminal (fail-safe: no auto-retry loop).
 */
export async function claimOneShotConsumption(pool: Pool, id: string): Promise<RequestRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const res = await pool.query<DbRequestRow>(
    `UPDATE capability_requests SET consume_status = 'consuming'
       WHERE id = $1 AND status = 'approved_once'
         AND (consume_status IS NULL OR consume_status = 'aborted')
     RETURNING *`,
    [id],
  );
  return res.rows[0] ? mapRequest(res.rows[0]) : null;
}

/**
 * SE-2: finalize a claimed consumption. `consumed` stamps consumed_at + the
 * landing tx (the audit trail); `aborted`/`failed` clear the claim per the
 * lifecycle above. Only a `consuming` row transitions (idempotent).
 */
export async function finalizeOneShotConsumption(
  pool: Pool,
  id: string,
  status: Exclude<ConsumeStatus, 'consuming'>,
  txHash?: string,
): Promise<RequestRow | null> {
  const res = await pool.query<DbRequestRow>(
    `UPDATE capability_requests
        SET consume_status = $2,
            consume_tx_hash = $3,
            consumed_at = CASE WHEN $2 = 'consumed' THEN now() ELSE consumed_at END
      WHERE id = $1 AND consume_status = 'consuming'
      RETURNING *`,
    [id, status, txHash ?? null],
  );
  return res.rows[0] ? mapRequest(res.rows[0]) : null;
}

/**
 * L-01 (SE-5.0): crash-durability for the fire-and-forget one-shot retry. The
 * owner-route trigger drives consumeApprovedOneShot in-memory; a backend restart
 * mid-retry drops it (request stays `approved_once`, consume_status NULL|aborted).
 * This lists the resumable ones — an approved_once whose consumption never landed,
 * still within the one-shot TTL — so a periodic sweep can re-drive them. A row
 * already `consuming`/`consumed`/`failed` is excluded (in-flight or terminal); the
 * TTL bound skips one-shots too stale to still be authorized on-chain. The CAS in
 * claimOneShotConsumption makes re-driving idempotent against the live trigger.
 */
export async function listResumableOneShots(
  pool: Pool,
  ttlMs: number,
): Promise<Array<{ id: string; agentId: string }>> {
  const res = await pool.query<{ id: string; agent_id: string }>(
    `SELECT id, agent_id FROM capability_requests
       WHERE status = 'approved_once'
         AND (consume_status IS NULL OR consume_status = 'aborted')
         AND decided_at IS NOT NULL
         AND decided_at > now() - ($1::bigint * interval '1 millisecond')
       ORDER BY decided_at ASC`,
    [Math.max(0, Math.floor(ttlMs))],
  );
  return res.rows.map((r) => ({ id: r.id, agentId: r.agent_id }));
}

/**
 * SE-5/SE-6 (E-5 + the SE-6 pre-req): read the JIT request grant state for an
 * OWNER-scoped (chainId, account) key. Scoped so a read on chain A can NEVER
 * surface chain B's requests — and, under CREATE2 same-address, so one owner can
 * NEVER surface another owner's requests through a shared account address (two
 * owners can deterministically hold the same address; owner_addr partitions
 * them). The chain_id filter + the owner-checked agent join keep the isolation
 * local + explicit.
 */
export async function listRequestsByChainAndAccount(
  pool: Pool,
  ownerAddr: string,
  chainId: number,
  accountAddr: string,
  limit = 50,
): Promise<RequestRow[]> {
  const res = await pool.query<DbRequestRow>(
    `SELECT cr.* FROM capability_requests cr
       JOIN agents a ON a.id = cr.agent_id
      WHERE a.owner_addr = $1 AND cr.chain_id = $2 AND a.account_addr = $3
      ORDER BY cr.created_at DESC LIMIT $4`,
    [ownerAddr.toLowerCase(), chainId, accountAddr.toLowerCase(), Math.min(Math.max(limit, 1), 200)],
  );
  return res.rows.map(mapRequest);
}

/** Recent JIT decisions for an agent (display in the CapabilityEnvelope). */
export async function listRecentRequests(pool: Pool, agentId: string, limit = 20): Promise<RequestRow[]> {
  const res = await pool.query<DbRequestRow>(
    `SELECT * FROM capability_requests WHERE agent_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [agentId, Math.min(Math.max(limit, 1), 100)],
  );
  return res.rows.map(mapRequest);
}
