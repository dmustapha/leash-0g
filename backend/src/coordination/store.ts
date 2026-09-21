import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Json } from '../crypto/canonical.js';
import type { Delegation, DelegationStatus, Link, LinkMode } from '../types.js';

/**
 * Links + delegations data access (spec §3b/§5). Links are the ONLY
 * authorization for delegation; kind/payload stay OPAQUE to this layer
 * (generality guard — no treasury-specific fields, ever). Envelope ids are
 * app-generated (single-use ids, spec §6).
 */

interface DbLinkRow {
  id: string;
  owner_addr: string;
  from_agent_id: string;
  to_agent_id: string;
  mode: LinkMode;
  status: 'active' | 'paused' | 'removed';
  created_at: Date;
}

function mapLink(r: DbLinkRow): Link {
  return {
    id: r.id,
    ownerAddr: r.owner_addr,
    fromAgentId: r.from_agent_id,
    toAgentId: r.to_agent_id,
    mode: r.mode,
    status: r.status,
    createdAt: r.created_at.toISOString(),
  };
}

interface DbDelegationRow {
  id: string;
  link_id: string;
  from_agent_id: string;
  to_agent_id: string;
  kind: string;
  payload: Json;
  status: DelegationStatus;
  result: Json | null;
  created_at: Date;
  decided_at: Date | null;
  expires_at: Date;
}

function mapDelegation(r: DbDelegationRow): Delegation {
  return {
    id: r.id,
    linkId: r.link_id,
    fromAgentId: r.from_agent_id,
    toAgentId: r.to_agent_id,
    kind: r.kind,
    payload: r.payload,
    status: r.status,
    ...(r.result !== null ? { result: r.result } : {}),
    createdAt: r.created_at.toISOString(),
    ...(r.decided_at !== null ? { decidedAt: r.decided_at.toISOString() } : {}),
    expiresAt: r.expires_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export interface CreateLinkInput {
  ownerAddr: string;
  fromAgentId: string;
  toAgentId: string;
  mode: LinkMode;
}

/** Raised on the (from,to) UNIQUE collision so routes can answer 409 cleanly. */
export class DuplicateLinkError extends Error {
  constructor() {
    super('link already exists for this (from, to) pair');
  }
}

export async function createLink(pool: Pool, input: CreateLinkInput): Promise<Link> {
  try {
    const res = await pool.query<DbLinkRow>(
      `INSERT INTO links (id, owner_addr, from_agent_id, to_agent_id, mode, status)
       VALUES ($1,$2,$3,$4,$5,'active') RETURNING *`,
      [randomUUID(), input.ownerAddr.toLowerCase(), input.fromAgentId, input.toAgentId, input.mode],
    );
    const row = res.rows[0];
    if (!row) throw new Error('link insert failed');
    return mapLink(row);
  } catch (err) {
    if (isUniqueViolation(err)) throw new DuplicateLinkError();
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

export async function getLink(pool: Pool, id: string): Promise<Link | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const res = await pool.query<DbLinkRow>(`SELECT * FROM links WHERE id = $1`, [id]);
  return res.rows[0] ? mapLink(res.rows[0]) : null;
}

/** Owner's links + per-link delegation counts (spec §4 GET /api/links). */
export async function listLinksByOwner(
  pool: Pool,
  ownerAddr: string,
): Promise<Array<Link & { delegationCount: number }>> {
  const res = await pool.query<DbLinkRow & { delegation_count: string }>(
    `SELECT l.*, count(d.id) AS delegation_count
     FROM links l LEFT JOIN delegations d ON d.link_id = l.id
     WHERE l.owner_addr = $1
     GROUP BY l.id ORDER BY l.created_at DESC`,
    [ownerAddr.toLowerCase()],
  );
  return res.rows.map((r) => ({ ...mapLink(r), delegationCount: Number(r.delegation_count) }));
}

export async function setLinkStatus(
  pool: Pool,
  id: string,
  status: 'active' | 'paused' | 'removed',
): Promise<Link | null> {
  const res = await pool.query<DbLinkRow>(`UPDATE links SET status = $2 WHERE id = $1 RETURNING *`, [id, status]);
  return res.rows[0] ? mapLink(res.rows[0]) : null;
}

export async function setLinkMode(pool: Pool, id: string, mode: LinkMode): Promise<Link | null> {
  const res = await pool.query<DbLinkRow>(`UPDATE links SET mode = $2 WHERE id = $1 RETURNING *`, [id, mode]);
  return res.rows[0] ? mapLink(res.rows[0]) : null;
}

/**
 * Resolve the ACTIVE outbound link for an issuer (spec §3b: no active link →
 * no channel). With several active outbound links and no toAgentId the OLDEST
 * link wins (deterministic; the specimen pair has exactly one).
 */
export async function findActiveLinkFrom(pool: Pool, fromAgentId: string, toAgentId?: string): Promise<Link | null> {
  const params: string[] = [fromAgentId];
  let sql = `SELECT * FROM links WHERE from_agent_id = $1 AND status = 'active'`;
  if (toAgentId !== undefined) {
    params.push(toAgentId);
    sql += ` AND to_agent_id = $2`;
  }
  sql += ` ORDER BY created_at ASC LIMIT 1`;
  const res = await pool.query<DbLinkRow>(sql, params);
  return res.rows[0] ? mapLink(res.rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Delegations
// ---------------------------------------------------------------------------

export interface CreateDelegationInput {
  linkId: string;
  fromAgentId: string;
  toAgentId: string;
  kind: string;
  payload: Json;
  status: Extract<DelegationStatus, 'pending' | 'pending_approval'>;
  expiresAt: Date;
}

export async function createDelegation(pool: Pool, input: CreateDelegationInput): Promise<Delegation> {
  const res = await pool.query<DbDelegationRow>(
    `INSERT INTO delegations (id, link_id, from_agent_id, to_agent_id, kind, payload, status, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      randomUUID(),
      input.linkId,
      input.fromAgentId,
      input.toAgentId,
      input.kind,
      JSON.stringify(input.payload),
      input.status,
      input.expiresAt.toISOString(),
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('delegation insert failed');
  return mapDelegation(row);
}

export async function getDelegation(pool: Pool, id: string): Promise<Delegation | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const res = await pool.query<DbDelegationRow>(`SELECT * FROM delegations WHERE id = $1`, [id]);
  return res.rows[0] ? mapDelegation(res.rows[0]) : null;
}

export interface ListDelegationsOptions {
  agentId?: string;
  linkId?: string;
  /** Keyset cursor `<createdAtISO>_<id>` from a previous page. */
  cursor?: string;
  limit?: number;
}

/**
 * Paged feed, created_at DESC (spec §4). Keyset cursor on (created_at, id)
 * — stable under concurrent inserts, unlike offset paging. agentId matches
 * EITHER side (the owner's per-agent feed shows both directions).
 */
export async function listDelegations(
  pool: Pool,
  opts: ListDelegationsOptions = {},
): Promise<{ delegations: Delegation[]; nextCursor?: string }> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.agentId !== undefined) {
    params.push(opts.agentId);
    where.push(`(from_agent_id = $${params.length} OR to_agent_id = $${params.length})`);
  }
  if (opts.linkId !== undefined) {
    params.push(opts.linkId);
    where.push(`link_id = $${params.length}`);
  }
  const cursor = opts.cursor !== undefined ? parseCursor(opts.cursor) : null;
  if (cursor) {
    params.push(cursor.createdAt, cursor.id);
    // ms-truncated on BOTH sides: JS Dates carry only ms, so the cursor is
    // ms-precise — comparing against the µs-precise column would skip rows
    // that share the boundary millisecond. Order and compare the same key.
    where.push(
      `(date_trunc('milliseconds', created_at), id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
    );
  }
  params.push(limit + 1);
  const res = await pool.query<DbDelegationRow>(
    `SELECT * FROM delegations ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY date_trunc('milliseconds', created_at) DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  const page = res.rows.slice(0, limit).map(mapDelegation);
  const last = page[page.length - 1];
  return {
    delegations: page,
    ...(res.rows.length > limit && last ? { nextCursor: `${last.createdAt}_${last.id}` } : {}),
  };
}

function parseCursor(raw: string): { createdAt: string; id: string } | null {
  const sep = raw.lastIndexOf('_');
  if (sep <= 0) return null;
  const createdAt = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  if (Number.isNaN(Date.parse(createdAt)) || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return { createdAt, id };
}

/** Spec §4: terminal — no resurrection; new work = new envelope. */
const TERMINAL_STATUSES: ReadonlySet<DelegationStatus> = new Set([
  'completed',
  'failed',
  'declined',
  'cancelled',
  'expired',
]);

/**
 * THE single serialized transition writer (spec §4 state machine): one atomic
 * compare-and-set — the row moves only if its current status is in
 * `fromStatuses`, so lost races and illegal transitions both surface as null.
 * Terminal stickiness is enforced HERE, not trusted to callers: a terminal
 * status is silently dropped from `fromStatuses`, so no caller can ever
 * resurrect a settled envelope. ALL status changes anywhere in the codebase
 * go through this function.
 */
export async function transitionDelegation(
  pool: Pool,
  id: string,
  fromStatuses: DelegationStatus[],
  to: DelegationStatus,
  patch?: { result?: Json; decidedAt?: boolean },
): Promise<Delegation | null> {
  const from = fromStatuses.filter((s) => !TERMINAL_STATUSES.has(s));
  if (from.length === 0) return null;
  const res = await pool.query<DbDelegationRow>(
    `UPDATE delegations
     SET status = $3,
         result = COALESCE($4::jsonb, result),
         decided_at = CASE WHEN $5 THEN now() ELSE decided_at END
     WHERE id = $1 AND status = ANY($2)
     RETURNING *`,
    [id, from, to, patch?.result !== undefined ? JSON.stringify(patch.result) : null, patch?.decidedAt === true],
  );
  return res.rows[0] ? mapDelegation(res.rows[0]) : null;
}

/**
 * Receiver pickup query (expiry point A of three, spec §3b): pending,
 * addressed to the agent, and NOT expired — an expired envelope is refused at
 * pickup even before the sweeper gets to it.
 */
export async function listActivatablePendingFor(pool: Pool, toAgentId: string, limit = 20): Promise<Delegation[]> {
  const res = await pool.query<DbDelegationRow>(
    `SELECT * FROM delegations
     WHERE to_agent_id = $1 AND status = 'pending' AND expires_at > now()
     ORDER BY created_at ASC LIMIT $2`,
    [toAgentId, Math.min(limit, 100)],
  );
  return res.rows.map(mapDelegation);
}

/**
 * Expiry points B (periodic sweeper) + C (boot sweep) share this: stale
 * pending/pending_approval rows → 'expired', each through the transition
 * writer (never a bulk UPDATE around it). Returns the swept rows so the
 * caller can trace + emit per delegation.
 */
export async function sweepExpiredDelegations(pool: Pool): Promise<Delegation[]> {
  const stale = await pool.query<{ id: string }>(
    `SELECT id FROM delegations
     WHERE status IN ('pending','pending_approval') AND expires_at <= now()
     ORDER BY created_at ASC`,
  );
  const swept: Delegation[] = [];
  for (const row of stale.rows) {
    const d = await transitionDelegation(pool, row.id, ['pending', 'pending_approval'], 'expired', {
      decidedAt: true,
    });
    if (d) swept.push(d); // null = raced with another transition — that writer won
  }
  return swept;
}

/** Throttle input: delegations created on the link in the trailing hour (ALL statuses). */
export async function countRecentByLink(pool: Pool, linkId: string): Promise<number> {
  const res = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM delegations WHERE link_id = $1 AND created_at > now() - interval '1 hour'`,
    [linkId],
  );
  return Number(res.rows[0]?.n ?? 0);
}

/** Throttle input: concurrently-pending envelopes on the link (incl. awaiting approval). */
export async function countPendingByLink(pool: Pool, linkId: string): Promise<number> {
  const res = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM delegations WHERE link_id = $1 AND status IN ('pending','pending_approval')`,
    [linkId],
  );
  return Number(res.rows[0]?.n ?? 0);
}

/** Non-terminal rows on a link, for pause/remove cancellation (spec §4 NOTE: accepted survives). */
export async function listCancellableByLink(pool: Pool, linkId: string): Promise<Delegation[]> {
  const res = await pool.query<DbDelegationRow>(
    `SELECT * FROM delegations WHERE link_id = $1 AND status IN ('pending','pending_approval') ORDER BY created_at ASC`,
    [linkId],
  );
  return res.rows.map(mapDelegation);
}

/** Every non-terminal delegation touching an agent, for revoke fan-out (spec §3b). */
export async function listOpenByAgent(pool: Pool, agentId: string): Promise<Delegation[]> {
  const res = await pool.query<DbDelegationRow>(
    `SELECT * FROM delegations
     WHERE (from_agent_id = $1 OR to_agent_id = $1)
       AND status IN ('pending','pending_approval','accepted')
     ORDER BY created_at ASC`,
    [agentId],
  );
  return res.rows.map(mapDelegation);
}
