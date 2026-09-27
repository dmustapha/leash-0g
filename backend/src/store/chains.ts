import type { Pool } from 'pg';
import type { Chain, ChainStep } from '../types.js';

/**
 * The `chains` projection (Phase 5.6, spec §5) — a runtime READ MODEL, not
 * authority. One row per owner-authored chain; advanced by CAS as each hop is
 * proposed / settled. It threads chainId/hopIndex over the EXISTING
 * links/delegations and confers NO goal/policy/spend (the downstream's own
 * on-chain leash binds every act). Mirrors the Phase-4 `jobs` projection (011).
 */

interface DbChainRow {
  id: string;
  owner_addr: string;
  origin_agent_id: string;
  direction_id: string;
  plan: ChainStep[];
  status: Chain['status'];
  next_hop: number;
  path: string[];
  current_delegation_id: string | null;
  created_at: Date;
  updated_at: Date;
}

function mapRow(r: DbChainRow): Chain {
  return {
    id: r.id,
    ownerAddr: r.owner_addr,
    originAgentId: r.origin_agent_id,
    directionId: r.direction_id,
    plan: r.plan,
    status: r.status,
    nextHop: r.next_hop,
    path: r.path,
    currentDelegationId: r.current_delegation_id,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

const COLS = `id, owner_addr, origin_agent_id, direction_id, plan, status, next_hop, path, current_delegation_id, created_at, updated_at`;

/**
 * Create a `planned` chain projection (called at direction confirm — D-1). The
 * path starts at the origin agent (the cycle-prevention re-check reads it).
 * Arms NO delegation; the plan is quarantined data, not authority.
 */
export async function insertPlannedChain(
  pool: Pool,
  input: { ownerAddr: string; originAgentId: string; directionId: string; plan: ChainStep[] },
): Promise<Chain> {
  const res = await pool.query<DbChainRow>(
    `INSERT INTO chains (owner_addr, origin_agent_id, direction_id, plan, status, next_hop, path)
     VALUES ($1,$2,$3,$4,'planned',0,$5) RETURNING ${COLS}`,
    [
      input.ownerAddr.toLowerCase(),
      input.originAgentId,
      input.directionId,
      JSON.stringify(input.plan),
      JSON.stringify([input.originAgentId]),
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('chain insert failed');
  return mapRow(row);
}

export async function getChain(pool: Pool, id: string): Promise<Chain | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const res = await pool.query<DbChainRow>(`SELECT ${COLS} FROM chains WHERE id = $1`, [id]);
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

/** Find the chain whose current in-flight hop is this delegation (onHopSettled). */
export async function getChainByCurrentDelegation(pool: Pool, delegationId: string): Promise<Chain | null> {
  if (!/^[0-9a-f-]{36}$/i.test(delegationId)) return null;
  const res = await pool.query<DbChainRow>(
    `SELECT ${COLS} FROM chains WHERE current_delegation_id = $1`,
    [delegationId],
  );
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

/** The chain(s) an agent originates that are still advancing (runtime hook). */
export async function listAdvancingChainsForOrigin(pool: Pool, originAgentId: string): Promise<Chain[]> {
  const res = await pool.query<DbChainRow>(
    `SELECT ${COLS} FROM chains
     WHERE origin_agent_id = $1 AND status IN ('planned','running') AND current_delegation_id IS NULL
     ORDER BY created_at ASC`,
    [originAgentId],
  );
  return res.rows.map(mapRow);
}

/**
 * Every advancing chain an agent originates, INCLUDING one with an in-flight hop
 * (unlike listAdvancingChainsForOrigin, which excludes in-flight for the hop-0
 * runtime hook). Used by owner wind-down (D-4) to fail every origin chain safe —
 * a `planned` chain (must not resume on restart) as well as a `running` chain
 * whose current hop must be cancelled.
 */
export async function listAllAdvancingChainsForOrigin(pool: Pool, originAgentId: string): Promise<Chain[]> {
  const res = await pool.query<DbChainRow>(
    `SELECT ${COLS} FROM chains
     WHERE origin_agent_id = $1 AND status IN ('planned','running')
     ORDER BY created_at ASC`,
    [originAgentId],
  );
  return res.rows.map(mapRow);
}

export interface ListChainsOptions {
  cursor?: string;
  limit?: number;
}

/** Owner-scoped, created_at DESC, keyset cursor `<createdAtISO>_<id>` (§4). */
export async function listChainsByOwner(
  pool: Pool,
  ownerAddr: string,
  opts: ListChainsOptions = {},
): Promise<{ chains: Chain[]; nextCursor?: string }> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const params: unknown[] = [ownerAddr.toLowerCase()];
  let where = `owner_addr = $1`;
  const cursor = opts.cursor !== undefined ? parseCursor(opts.cursor) : null;
  if (cursor) {
    params.push(cursor.createdAt, cursor.id);
    where += ` AND (date_trunc('milliseconds', created_at), id) < ($2::timestamptz, $3::uuid)`;
  }
  params.push(limit + 1);
  const res = await pool.query<DbChainRow>(
    `SELECT ${COLS} FROM chains WHERE ${where}
     ORDER BY date_trunc('milliseconds', created_at) DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  const page = res.rows.slice(0, limit).map(mapRow);
  const last = page[page.length - 1];
  return {
    chains: page,
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

/**
 * CLAIM a hop for proposal (idempotent CAS, D-2/§3b). Atomically: bumps
 * next_hop hopIndex→hopIndex+1, appends the selected target to the path, sets
 * status 'running'. Guarded so a hop is claimed EXACTLY ONCE:
 *   - next_hop MUST equal hopIndex (a second proposer for the same hop loses),
 *   - status MUST be planned/running (a terminated/completed chain can't advance),
 *   - current_delegation_id MUST be null (no hop already in flight).
 * Returns the updated chain on success, null when the claim is lost/invalid.
 * The winner then issues the hop delegation and calls setChainCurrentDelegation.
 */
export async function claimChainHop(
  pool: Pool,
  chainId: string,
  hopIndex: number,
  selectedTargetId: string,
): Promise<Chain | null> {
  const res = await pool.query<DbChainRow>(
    `UPDATE chains
       SET next_hop = $2 + 1,
           path = path || to_jsonb($3::text),
           status = 'running',
           updated_at = now()
     WHERE id = $1 AND next_hop = $2 AND status IN ('planned','running')
       AND current_delegation_id IS NULL
     RETURNING ${COLS}`,
    [chainId, hopIndex, selectedTargetId],
  );
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

/**
 * Reverse a claim (code-review W1): if issuing the hop delegation fails with a
 * TRANSIENT infra error (not a deterministic CoordinationError), roll the claim
 * back — restore next_hop hopIndex+1→hopIndex, pop the selected target off the
 * path — so the next runtime tick can RE-propose the same hop instead of a
 * transient DB blip permanently killing the chain. Guarded so it only reverses
 * OUR own un-bound claim (current_delegation_id still NULL, next_hop still at
 * hopIndex+1); a no-op otherwise.
 */
export async function releaseChainHop(pool: Pool, chainId: string, hopIndex: number): Promise<Chain | null> {
  const res = await pool.query<DbChainRow>(
    `UPDATE chains
       SET next_hop = $2,
           path = path - (jsonb_array_length(path) - 1),
           status = CASE WHEN $2 = 0 THEN 'planned' ELSE 'running' END,
           updated_at = now()
     WHERE id = $1 AND next_hop = $2 + 1 AND current_delegation_id IS NULL
     RETURNING ${COLS}`,
    [chainId, hopIndex],
  );
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

/** Bind the claimed hop to its issued delegation (threads the ordered view). */
export async function setChainCurrentDelegation(
  pool: Pool,
  chainId: string,
  delegationId: string,
): Promise<void> {
  await pool.query(`UPDATE chains SET current_delegation_id = $2, updated_at = now() WHERE id = $1`, [
    chainId,
    delegationId,
  ]);
}

/**
 * Settle the in-flight hop: clear current_delegation_id so the NEXT hop can be
 * claimed, and (optionally) move the chain to a terminal status. A no-op if the
 * chain isn't pointing at this delegation (raced with another settle path).
 *
 * Guarded (D-12 races): only an ADVANCING chain (`planned`/`running`) can be
 * settled — a late/duplicate completed-outcome can NEVER resurrect a
 * `terminated`/`completed` chain back to running/completed. When the caller knows
 * which delegation it is settling, it passes `expectedDelegationId` so the write
 * additionally requires the chain to still be pointing at exactly that hop
 * (the W2 reconciliation path passes undefined, having already re-derived the
 * chain from the payload hint under its own null-current-delegation guard).
 */
export async function settleChainHop(
  pool: Pool,
  chainId: string,
  status: Chain['status'],
  expectedDelegationId?: string,
): Promise<Chain | null> {
  const res = await pool.query<DbChainRow>(
    `UPDATE chains SET current_delegation_id = NULL, status = $2, updated_at = now()
     WHERE id = $1 AND status IN ('planned','running')
       AND ($3::uuid IS NULL OR current_delegation_id = $3::uuid)
     RETURNING ${COLS}`,
    [chainId, status, expectedDelegationId ?? null],
  );
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

/** Terminate a chain (denied/stand-down/depth/wind-down/revoke). Idempotent. */
export async function terminateChain(pool: Pool, chainId: string): Promise<Chain | null> {
  const res = await pool.query<DbChainRow>(
    `UPDATE chains SET status = 'terminated', current_delegation_id = NULL, updated_at = now()
     WHERE id = $1 AND status IN ('planned','running') RETURNING ${COLS}`,
    [chainId],
  );
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}
