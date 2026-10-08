import type { Pool } from 'pg';
import type { Json } from '../crypto/canonical.js';
import type { SigningRule, SigningTrigger } from '../signing/index.js';

/**
 * Stage F′ / FP-2 governed-signing read-model store (migration 027). DISPLAY +
 * JIT-workflow + arm-reconcile state ONLY — the on-chain `LeashAccountV5` wall is
 * the sole authority. Mirror of `store/tools.ts`.
 */

// ---------------------------------------------------------------------------
// signing_rules — the owner's standing per-descriptor grant.
// ---------------------------------------------------------------------------

export type SigningGrantStatus = 'proposed' | 'active' | 'removed';

export interface SigningRuleRow {
  id: string;
  agentId: string;
  chainId: number;
  ownerAddr: string;
  descriptorId: number;
  descriptorKey: string;
  token: string;
  perIntentCap: string;
  maxDeadlineWindow: number;
  spenderSet: string[];
  /** FP-4 Slice-5: the batch per-token cap allowlist (empty for non-batch rules). */
  tokenCaps: { token: string; cap: string }[];
  source: string;
  status: SigningGrantStatus;
  createdAt: string;
  updatedAt: string;
}

interface DbSigningRuleRow {
  id: string;
  agent_id: string;
  chain_id: string;
  owner_addr: string;
  descriptor_id: string;
  descriptor_key: string;
  token: string;
  per_intent_cap: string;
  max_deadline_window: string;
  spender_set: string[];
  token_caps: { token: string; cap: string }[];
  source: string;
  status: SigningGrantStatus;
  created_at: Date;
  updated_at: Date;
}

function mapRule(r: DbSigningRuleRow): SigningRuleRow {
  return {
    id: r.id,
    agentId: r.agent_id,
    chainId: Number(r.chain_id),
    ownerAddr: r.owner_addr,
    descriptorId: Number(r.descriptor_id),
    descriptorKey: r.descriptor_key,
    token: r.token,
    perIntentCap: r.per_intent_cap,
    maxDeadlineWindow: Number(r.max_deadline_window),
    spenderSet: r.spender_set,
    tokenCaps: r.token_caps ?? [],
    source: r.source,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export interface UpsertSigningRuleInput {
  agentId: string;
  ownerAddr: string;
  descriptorKey: string;
  rule: SigningRule;
  source: string;
  status: SigningGrantStatus;
}

export async function upsertSigningRule(pool: Pool, input: UpsertSigningRuleInput): Promise<SigningRuleRow> {
  const { rule } = input;
  const res = await pool.query<DbSigningRuleRow>(
    `INSERT INTO signing_rules
       (agent_id, chain_id, owner_addr, descriptor_id, descriptor_key, token, per_intent_cap, max_deadline_window, spender_set, token_caps, source, status)
     VALUES ($1, (SELECT chain_id FROM agents WHERE id = $1), $2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (agent_id, descriptor_id) DO UPDATE SET
       descriptor_key      = EXCLUDED.descriptor_key,
       token               = EXCLUDED.token,
       per_intent_cap      = EXCLUDED.per_intent_cap,
       max_deadline_window = EXCLUDED.max_deadline_window,
       spender_set         = EXCLUDED.spender_set,
       token_caps          = EXCLUDED.token_caps,
       source              = EXCLUDED.source,
       status              = EXCLUDED.status,
       updated_at          = now()
     RETURNING *`,
    [
      input.agentId,
      input.ownerAddr.toLowerCase(),
      rule.descriptorId,
      input.descriptorKey,
      rule.token.toLowerCase(),
      rule.perIntentCap,
      rule.maxDeadlineWindow,
      JSON.stringify(rule.spenderSet.map((s) => s.toLowerCase())),
      JSON.stringify((rule.tokenCaps ?? []).map((c) => ({ token: c.token.toLowerCase(), cap: c.cap }))),
      input.source,
      input.status,
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('signing_rules upsert failed');
  return mapRule(row);
}

export async function setSigningRuleStatus(
  pool: Pool,
  agentId: string,
  descriptorId: number,
  status: SigningGrantStatus,
): Promise<SigningRuleRow | null> {
  const res = await pool.query<DbSigningRuleRow>(
    `UPDATE signing_rules SET status = $3, updated_at = now()
     WHERE agent_id = $1 AND descriptor_id = $2 RETURNING *`,
    [agentId, descriptorId, status],
  );
  return res.rows[0] ? mapRule(res.rows[0]) : null;
}

export async function listSigningRules(pool: Pool, agentId: string, includeRemoved = false): Promise<SigningRuleRow[]> {
  const res = await pool.query<DbSigningRuleRow>(
    `SELECT * FROM signing_rules WHERE agent_id = $1
       ${includeRemoved ? '' : "AND status <> 'removed'"}
     ORDER BY created_at DESC`,
    [agentId],
  );
  return res.rows.map(mapRule);
}

// ---------------------------------------------------------------------------
// signing_requests — the L2 JIT workflow store (quarantined).
// ---------------------------------------------------------------------------

export type SigningRequestStatus = 'pending' | 'approved_once' | 'always_allowed' | 'denied' | 'expired';

export interface SigningRequestRow {
  id: string;
  agentId: string;
  chainId: number;
  ownerAddr: string;
  descriptorId: number;
  decoded: Json;
  triggers: SigningTrigger[];
  requestHash: string;
  intent: Json;
  status: SigningRequestStatus;
  approvalId: string | null;
  createdAt: string;
  decidedAt: string | null;
}

interface DbSigningRequestRow {
  id: string;
  agent_id: string;
  chain_id: string;
  owner_addr: string;
  descriptor_id: string;
  decoded: Json;
  triggers: SigningTrigger[];
  request_hash: string;
  intent: Json;
  status: SigningRequestStatus;
  approval_id: string | null;
  created_at: Date;
  decided_at: Date | null;
}

function mapRequest(r: DbSigningRequestRow): SigningRequestRow {
  return {
    id: r.id,
    agentId: r.agent_id,
    chainId: Number(r.chain_id),
    ownerAddr: r.owner_addr,
    descriptorId: Number(r.descriptor_id),
    decoded: r.decoded,
    triggers: r.triggers,
    requestHash: r.request_hash,
    intent: r.intent,
    status: r.status,
    approvalId: r.approval_id,
    createdAt: r.created_at.toISOString(),
    decidedAt: r.decided_at ? r.decided_at.toISOString() : null,
  };
}

export interface InsertSigningRequestInput {
  agentId: string;
  ownerAddr: string;
  descriptorId: number;
  decoded: Json;
  triggers: SigningTrigger[];
  requestHash: string;
  intent: Json;
}

export async function insertSigningRequest(
  pool: Pool,
  input: InsertSigningRequestInput,
): Promise<{ row: SigningRequestRow; created: boolean }> {
  const res = await pool.query<DbSigningRequestRow>(
    `INSERT INTO signing_requests (agent_id, chain_id, owner_addr, descriptor_id, decoded, triggers, request_hash, intent)
     VALUES ($1, (SELECT chain_id FROM agents WHERE id = $1), $2,$3,$4,$5,$6,$7)
     ON CONFLICT (agent_id, request_hash) WHERE status = 'pending' DO NOTHING
     RETURNING *`,
    [
      input.agentId,
      input.ownerAddr.toLowerCase(),
      input.descriptorId,
      JSON.stringify(input.decoded),
      JSON.stringify(input.triggers),
      input.requestHash,
      JSON.stringify(input.intent),
    ],
  );
  if (res.rows[0]) return { row: mapRequest(res.rows[0]), created: true };
  const existing = await pool.query<DbSigningRequestRow>(
    `SELECT * FROM signing_requests WHERE agent_id = $1 AND request_hash = $2 AND status = 'pending'`,
    [input.agentId, input.requestHash],
  );
  const row = existing.rows[0];
  if (!row) throw new Error('signing_requests insert raced without a pending row');
  return { row: mapRequest(row), created: false };
}

export async function setSigningRequestApproval(pool: Pool, id: string, approvalId: string): Promise<void> {
  await pool.query(`UPDATE signing_requests SET approval_id = $2 WHERE id = $1`, [id, approvalId]);
}

export async function getSigningRequest(pool: Pool, id: string): Promise<SigningRequestRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const res = await pool.query<DbSigningRequestRow>(`SELECT * FROM signing_requests WHERE id = $1`, [id]);
  return res.rows[0] ? mapRequest(res.rows[0]) : null;
}

export async function setSigningRequestDecision(
  pool: Pool,
  id: string,
  status: Exclude<SigningRequestStatus, 'pending'>,
): Promise<SigningRequestRow | null> {
  const res = await pool.query<DbSigningRequestRow>(
    `UPDATE signing_requests SET status = $2, decided_at = now()
     WHERE id = $1 AND status = 'pending' RETURNING *`,
    [id, status],
  );
  return res.rows[0] ? mapRequest(res.rows[0]) : null;
}

export async function listRecentSigningRequests(pool: Pool, agentId: string, limit = 20): Promise<SigningRequestRow[]> {
  const res = await pool.query<DbSigningRequestRow>(
    `SELECT * FROM signing_requests WHERE agent_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [agentId, Math.min(Math.max(limit, 1), 100)],
  );
  return res.rows.map(mapRequest);
}

// ---------------------------------------------------------------------------
// signing_arms — the armed-intent read-model (FP-CARRY-4/5 reconcile).
// ---------------------------------------------------------------------------

export type SigningArmStatus = 'armed' | 'stale' | 'disarmed' | 'expired';

export interface SigningArmRow {
  id: string;
  agentId: string;
  chainId: number;
  descriptorId: number;
  digest: string;
  spender: string;
  amount: string;
  deadline: number;
  epoch: number;
  status: SigningArmStatus;
  createdAt: string;
  updatedAt: string;
}

interface DbSigningArmRow {
  id: string;
  agent_id: string;
  chain_id: string;
  descriptor_id: string;
  digest: string;
  spender: string;
  amount: string;
  deadline: string;
  epoch: string;
  status: SigningArmStatus;
  created_at: Date;
  updated_at: Date;
}

function mapArm(r: DbSigningArmRow): SigningArmRow {
  return {
    id: r.id,
    agentId: r.agent_id,
    chainId: Number(r.chain_id),
    descriptorId: Number(r.descriptor_id),
    digest: r.digest,
    spender: r.spender,
    amount: r.amount,
    deadline: Number(r.deadline),
    epoch: Number(r.epoch),
    status: r.status,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export interface RecordSigningArmInput {
  agentId: string;
  descriptorId: number;
  digest: string;
  spender: string;
  amount: string;
  deadline: number;
  epoch: number;
}

/** Record (or refresh) an armed intent in the read-model after the session key arms it on-chain. */
export async function recordSigningArm(pool: Pool, input: RecordSigningArmInput): Promise<SigningArmRow> {
  const res = await pool.query<DbSigningArmRow>(
    `INSERT INTO signing_arms (agent_id, chain_id, descriptor_id, digest, spender, amount, deadline, epoch, status)
     VALUES ($1, (SELECT chain_id FROM agents WHERE id = $1), $2,$3,$4,$5,$6,$7,'armed')
     ON CONFLICT (agent_id, digest) DO UPDATE SET
       spender = EXCLUDED.spender, amount = EXCLUDED.amount, deadline = EXCLUDED.deadline,
       epoch = EXCLUDED.epoch, status = 'armed', updated_at = now()
     RETURNING *`,
    [input.agentId, input.descriptorId, input.digest.toLowerCase(), input.spender.toLowerCase(), input.amount, input.deadline, input.epoch],
  );
  const row = res.rows[0];
  if (!row) throw new Error('signing_arms record failed');
  return mapArm(row);
}

/**
 * FP-CARRY-4/5 reconcile: after any signing-relevant tighten/remove/revoke bumps
 * the on-chain `signingEpoch`, mark every still-'armed' intent snapshotting an
 * OLDER epoch as 'stale' — so the owner/agent UI never shows a dead arm as live.
 * Returns the number of arms reconciled. Idempotent.
 */
export async function reconcileSigningArms(pool: Pool, agentId: string, currentEpoch: number): Promise<number> {
  const res = await pool.query(
    `UPDATE signing_arms SET status = 'stale', updated_at = now()
     WHERE agent_id = $1 AND status = 'armed' AND epoch < $2`,
    [agentId, currentEpoch],
  );
  return res.rowCount ?? 0;
}

/**
 * FP-CARRY-4 reconcile, SCOPED to one descriptor. Removing a single descriptor kills
 * only ITS arms — not every descriptor's. Use this on the owner `remove` path instead
 * of the epoch-sentinel call (which stales ALL descriptors' arms: fail-safe, but it
 * over-marks unrelated live arms). Stales every still-'armed' arm of this descriptor
 * regardless of epoch (the descriptor is gone, so all its arms are dead). Idempotent.
 */
export async function reconcileSigningArmsByDescriptor(
  pool: Pool,
  agentId: string,
  descriptorId: number,
): Promise<number> {
  const res = await pool.query(
    `UPDATE signing_arms SET status = 'stale', updated_at = now()
     WHERE agent_id = $1 AND status = 'armed' AND descriptor_id = $2`,
    [agentId, descriptorId],
  );
  return res.rowCount ?? 0;
}

export async function setSigningArmStatus(
  pool: Pool,
  agentId: string,
  digest: string,
  status: SigningArmStatus,
): Promise<SigningArmRow | null> {
  const res = await pool.query<DbSigningArmRow>(
    `UPDATE signing_arms SET status = $3, updated_at = now()
     WHERE agent_id = $1 AND digest = $2 RETURNING *`,
    [agentId, digest.toLowerCase(), status],
  );
  return res.rows[0] ? mapArm(res.rows[0]) : null;
}

export async function listSigningArms(pool: Pool, agentId: string, limit = 50): Promise<SigningArmRow[]> {
  const res = await pool.query<DbSigningArmRow>(
    `SELECT * FROM signing_arms WHERE agent_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [agentId, Math.min(Math.max(limit, 1), 200)],
  );
  return res.rows.map(mapArm);
}
