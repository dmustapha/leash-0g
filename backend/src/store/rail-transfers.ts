import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import type { Json } from '../crypto/canonical.js';

/**
 * The cross-chain rail recovery state machine (AQ-FND M-4) — FIRST-CLASS TYPED
 * STATE, not an error path. One row per value movement across a real rail
 * (Chainlink CCIP for 0G legs; CCTP v2 for Base/Eth/Arb USDC legs — D-5). The row
 * is what turns an un-filled hop into a reconcilable state the recovery sweep
 * owns, exactly as migration 035 turned an unresolved fee transfer reconcilable.
 *
 * Every transition is a CAS (`UPDATE … WHERE status = $old`), so a double tick, a
 * racing sweep, or a checkpoint replay writes exactly once. The on-chain custody
 * wall (per-asset caps, same-address bridge-gate) remains the sole enforcement
 * guarantee; this table only tracks the OUTCOME of a leg so recovery is possible.
 *
 * Route-SELECTION (which rail, when to refuse an unrecoverable route) is A3/A5
 * consumer logic (spec §M-4) and lives nowhere here; the only guard this layer
 * owns is G-9's by-construction one: a transfer cannot be initiated without a
 * funded destination-gas plan (`destGasPlan` is NOT NULL).
 */

export type Rail = 'cctp' | 'ccip';
/** CCTP self-rescues forward (re-mint retained message bytes); CCIP refunds on expiry. */
export type RecoveryMode = 'forward_mint' | 'refund_expiry';

export type RailTransferStatus =
  | 'initiated' // source leg broadcast, src hash write-ahead; not yet confirmed
  | 'source_confirmed' // source tx mined OK (burn / ccipSend done)
  | 'attested' // off-chain proof ready (CCTP attestation / CCIP commit) — dest leg submittable
  | 'filling' // destination mint/exec broadcast, dest hash write-ahead
  | 'filled' // destination confirmed — funds on the same-address dest account (TERMINAL ok)
  | 'no_fill' // destination did not fill within the window — recovery owns it
  | 'recovering' // a recovery attempt (forward re-mint / refund) broadcast
  | 'refunded' // refund confirmed on source (TERMINAL)
  | 'failed'; // source reverted / unrecoverable (TERMINAL)

export const TERMINAL_RAIL_STATUSES: readonly RailTransferStatus[] = ['filled', 'refunded', 'failed'];
export const OPEN_RAIL_STATUSES: readonly RailTransferStatus[] = [
  'initiated',
  'source_confirmed',
  'attested',
  'filling',
  'no_fill',
  'recovering',
];

/**
 * The funded destination-gas plan G-9 requires. A route is only enterable with
 * one — the agent must be able to pay for the destination leg (mint / exec) or
 * the funds strand. `fundedWei` is the gas budgeted on the destination chain;
 * `source` records how it was secured (already-held, a refuel leg, or an ERC-20
 * paymaster — the M-3 self-funding ladder).
 */
export interface DestGasPlan {
  destChainId: number;
  fundedWei: string;
  source: 'prefunded' | 'refuel' | 'paymaster';
  [k: string]: Json;
}

export interface RailTransferRow {
  railId: string;
  agentId: string;
  accountAddr: string;
  rail: Rail;
  recoveryMode: RecoveryMode;
  srcChainId: number;
  destChainId: number;
  asset: string;
  amountWei: string;
  status: RailTransferStatus;
  destGasPlan: DestGasPlan;
  srcTx: string | null;
  destTx: string | null;
  refundTx: string | null;
  attestation: string | null;
  messageBytes: string | null;
  minOutputWei: string | null;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RailDbRow {
  rail_id: string;
  agent_id: string;
  account_addr: string;
  rail: Rail;
  recovery_mode: RecoveryMode;
  src_chain_id: number;
  dest_chain_id: number;
  asset: string;
  amount_wei: string;
  status: RailTransferStatus;
  dest_gas_plan: DestGasPlan;
  src_tx: string | null;
  dest_tx: string | null;
  refund_tx: string | null;
  attestation: string | null;
  message_bytes: string | null;
  min_output_wei: string | null;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

const COLS =
  'rail_id, agent_id, account_addr, rail, recovery_mode, src_chain_id, dest_chain_id, asset, amount_wei, ' +
  'status, dest_gas_plan, src_tx, dest_tx, refund_tx, attestation, message_bytes, min_output_wei, ' +
  'attempt_count, max_attempts, next_attempt_at, last_error, created_at, updated_at';

function toRow(r: RailDbRow): RailTransferRow {
  return {
    railId: r.rail_id,
    agentId: r.agent_id,
    accountAddr: r.account_addr,
    rail: r.rail,
    recoveryMode: r.recovery_mode,
    srcChainId: r.src_chain_id,
    destChainId: r.dest_chain_id,
    asset: r.asset,
    amountWei: r.amount_wei,
    status: r.status,
    destGasPlan: r.dest_gas_plan,
    srcTx: r.src_tx,
    destTx: r.dest_tx,
    refundTx: r.refund_tx,
    attestation: r.attestation,
    messageBytes: r.message_bytes,
    minOutputWei: r.min_output_wei,
    attemptCount: r.attempt_count,
    maxAttempts: r.max_attempts,
    nextAttemptAt: r.next_attempt_at ? r.next_attempt_at.toISOString() : null,
    lastError: r.last_error,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export interface InitiateRailInput {
  agentId: string;
  accountAddr: string;
  rail: Rail;
  srcChainId: number;
  destChainId: number;
  asset: string;
  amountWei: string;
  /** G-9: a route is ONLY enterable with a funded destination-gas plan. Required. */
  destGasPlan: DestGasPlan;
  /** slippage floor asserted on the leg; null for a 1:1 lock-mint rail (CCIP tokens). */
  minOutputWei?: string | null;
  /**
   * How this leg recovers a no-fill. Defaults by rail (CCTP forward-only self-rescue;
   * CCIP refund-on-expiry) but is overridable — the A5 route-planner knows whether a
   * given lane can retry-execute forward or must refund, and that is its call to make.
   */
  recoveryMode?: RecoveryMode;
  maxAttempts?: number;
  railId?: string;
}

export class UnfundedRouteError extends Error {
  constructor(detail: string) {
    super(`rail transfer REFUSED (unfunded_route): ${detail}`);
    this.name = 'UnfundedRouteError';
  }
}

/**
 * Open a rail transfer in `initiated`. The recovery_mode is implied by the rail
 * (CCTP forward-mint self-rescue; CCIP refund-on-expiry — spec §M-4). REFUSES a
 * route with no funded destination-gas plan (G-9's by-construction guard) — the
 * substrate cannot even record an un-prefundable route.
 */
export async function initiateRailTransfer(pool: Pool, input: InitiateRailInput): Promise<RailTransferRow> {
  const plan = input.destGasPlan;
  if (!plan || plan.destChainId !== input.destChainId) {
    throw new UnfundedRouteError(
      `destination-gas plan missing or for the wrong chain (plan=${plan?.destChainId}, dest=${input.destChainId})`,
    );
  }
  if (!/^\d+$/.test(plan.fundedWei) || BigInt(plan.fundedWei) <= 0n) {
    throw new UnfundedRouteError(`destination-gas plan funds nothing (fundedWei=${plan.fundedWei})`);
  }
  const recoveryMode: RecoveryMode = input.recoveryMode ?? (input.rail === 'cctp' ? 'forward_mint' : 'refund_expiry');
  const res = await pool.query<RailDbRow>(
    `INSERT INTO rail_transfers
       (rail_id, agent_id, account_addr, rail, recovery_mode, src_chain_id, dest_chain_id, asset, amount_wei,
        status, dest_gas_plan, min_output_wei, max_attempts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'initiated',$10,$11,$12)
     RETURNING ${COLS}`,
    [
      input.railId ?? randomUUID(),
      input.agentId,
      input.accountAddr.toLowerCase(),
      input.rail,
      recoveryMode,
      input.srcChainId,
      input.destChainId,
      input.asset.toLowerCase(),
      input.amountWei,
      JSON.stringify(plan),
      input.minOutputWei ?? null,
      input.maxAttempts ?? 3,
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('initiateRailTransfer failed');
  return toRow(row);
}

export async function getRailTransfer(pool: Pool, railId: string): Promise<RailTransferRow | null> {
  const res = await pool.query<RailDbRow>(`SELECT ${COLS} FROM rail_transfers WHERE rail_id = $1`, [railId]);
  const row = res.rows[0];
  return row ? toRow(row) : null;
}

/** Write-ahead the source leg hash (before its receipt is waited on) — initiated row only. */
export async function recordSourceSubmitted(pool: Pool, railId: string, srcTx: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE rail_transfers SET src_tx = $2, updated_at = now() WHERE rail_id = $1 AND status = 'initiated'`,
    [railId, srcTx],
  );
  return (r.rowCount ?? 0) === 1;
}

/** Source leg mined OK: initiated → source_confirmed. */
export async function markSourceConfirmed(pool: Pool, railId: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE rail_transfers SET status = 'source_confirmed', updated_at = now()
       WHERE rail_id = $1 AND status = 'initiated'`,
    [railId],
  );
  return (r.rowCount ?? 0) === 1;
}

/** Off-chain proof retrieved: source_confirmed → attested, retaining the proof for the mint leg. */
export async function markAttested(
  pool: Pool,
  railId: string,
  proof: { attestation?: string | null; messageBytes?: string | null },
): Promise<boolean> {
  const r = await pool.query(
    `UPDATE rail_transfers SET status = 'attested', attestation = $2, message_bytes = $3, updated_at = now()
       WHERE rail_id = $1 AND status IN ('source_confirmed', 'no_fill', 'recovering')`,
    [railId, proof.attestation ?? null, proof.messageBytes ?? null],
  );
  return (r.rowCount ?? 0) === 1;
}

/** Write-ahead the destination mint/exec hash: attested → filling. */
export async function recordFillSubmitted(pool: Pool, railId: string, destTx: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE rail_transfers SET status = 'filling', dest_tx = $2, updated_at = now()
       WHERE rail_id = $1 AND status IN ('attested', 'recovering')`,
    [railId, destTx],
  );
  return (r.rowCount ?? 0) === 1;
}

/** Destination confirmed — TERMINAL success: filling → filled. */
export async function markFilled(pool: Pool, railId: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE rail_transfers SET status = 'filled', updated_at = now()
       WHERE rail_id = $1 AND status = 'filling'`,
    [railId],
  );
  return (r.rowCount ?? 0) === 1;
}

/**
 * The window elapsed with no fill: any non-terminal pre-fill state → no_fill, with a
 * backoff before the recovery sweep may act. This is the recovery TRIGGER, a
 * first-class state — never an error path that drops the funds' handle.
 */
export async function markNoFill(
  pool: Pool,
  railId: string,
  opts: { nextAttemptAt: Date; lastError?: string },
): Promise<boolean> {
  const r = await pool.query(
    `UPDATE rail_transfers SET status = 'no_fill', next_attempt_at = $2, last_error = $3, updated_at = now()
       WHERE rail_id = $1 AND status IN ('source_confirmed', 'attested', 'filling')`,
    [railId, opts.nextAttemptAt, opts.lastError ?? null],
  );
  return (r.rowCount ?? 0) === 1;
}

/**
 * Claim a no_fill row for a recovery attempt (CAS, increments attempt_count):
 * no_fill → recovering. Returns the claimed row iff THIS caller won the race AND
 * attempts remain, so two sweep ticks can never double-submit the recovery leg.
 */
export async function claimRecovery(pool: Pool, railId: string): Promise<RailTransferRow | null> {
  const res = await pool.query<RailDbRow>(
    `UPDATE rail_transfers SET status = 'recovering', attempt_count = attempt_count + 1, updated_at = now()
       WHERE rail_id = $1 AND status = 'no_fill' AND attempt_count < max_attempts
       RETURNING ${COLS}`,
    [railId],
  );
  const row = res.rows[0];
  return row ? toRow(row) : null;
}

/** A recovery attempt did not land: recovering → no_fill (re-armed for the next tick). */
export async function requeueRecovery(
  pool: Pool,
  railId: string,
  opts: { nextAttemptAt: Date; lastError?: string },
): Promise<boolean> {
  const r = await pool.query(
    `UPDATE rail_transfers SET status = 'no_fill', next_attempt_at = $2, last_error = $3, updated_at = now()
       WHERE rail_id = $1 AND status = 'recovering'`,
    [railId, opts.nextAttemptAt, opts.lastError ?? null],
  );
  return (r.rowCount ?? 0) === 1;
}

/** Refund leg confirmed on source — TERMINAL: recovering → refunded. */
export async function markRefunded(pool: Pool, railId: string, refundTx: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE rail_transfers SET status = 'refunded', refund_tx = $2, updated_at = now()
       WHERE rail_id = $1 AND status = 'recovering'`,
    [railId, refundTx],
  );
  return (r.rowCount ?? 0) === 1;
}

/**
 * Terminal failure — source reverted or recovery exhausted. CAS from any
 * non-terminal state. An exhausted (`attempt_count >= max_attempts`) no_fill row
 * is marked failed here and LOGGED LOUDLY (the sweep), never silently dropped.
 */
export async function markFailed(pool: Pool, railId: string, lastError: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE rail_transfers SET status = 'failed', last_error = $2, updated_at = now()
       WHERE rail_id = $1 AND status NOT IN ('filled', 'refunded', 'failed')`,
    [railId, lastError],
  );
  return (r.rowCount ?? 0) > 0;
}

/** The recovery sweep's work set: open rows due for a look, oldest first. */
export async function listOpenRailTransfers(pool: Pool, limit = 50): Promise<RailTransferRow[]> {
  const res = await pool.query<RailDbRow>(
    `SELECT ${COLS} FROM rail_transfers
       WHERE status IN ('initiated','source_confirmed','attested','filling','no_fill','recovering')
         AND (next_attempt_at IS NULL OR next_attempt_at <= now())
       ORDER BY created_at ASC
       LIMIT $1`,
    [limit],
  );
  return res.rows.map(toRow);
}

export async function listRailTransfersForAgent(pool: Pool, agentId: string, limit = 50): Promise<RailTransferRow[]> {
  const res = await pool.query<RailDbRow>(
    `SELECT ${COLS} FROM rail_transfers WHERE agent_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [agentId, limit],
  );
  return res.rows.map(toRow);
}
