import type { Pool } from 'pg';
import type { Json } from '../crypto/canonical.js';
import type { JobSpec } from '../jobs/envelopes.js';
import type { AcceptanceResult } from '../jobs/acceptance.js';
import type { PoaRecord } from '../jobs/poa.js';

/**
 * The `jobs` projection (spec §5) — a runtime READ MODEL, not authority. One
 * row per ACP job, advanced as the lifecycle moves through the three roles.
 * The deliverable is stored PLAINTEXT here (hot) for the evaluator to read; the
 * owner-only ECIES copy on 0G Storage is the permanent audit artifact. Only
 * hashes/roots/sigs enter the verified PoA (F-quar / L-1).
 */

export type JobStatus =
  | 'originated'
  | 'delivered'
  | 'evaluating'
  | 'verdict'
  | 'awaiting_approval'
  | 'settling'
  | 'settled'
  | 'rejected'
  | 'denied'
  | 'failed';

export interface JobRow {
  jobId: string;
  ownerAddr: string;
  requesterAgentId: string;
  providerAgentId: string;
  evaluatorAgentId: string;
  status: JobStatus;
  spec: JobSpec;
  jobSpecHash: string;
  requesterSig: string;
  feeToken: string;
  feeAmountWei: string;
  feeRecipient: string;
  deliverable: Json | null;
  deliverableRoot: string | null;
  deliverableSummary: string | null;
  providerSig: string | null;
  acceptance: AcceptanceResult | null;
  verdict: 'accept' | 'reject' | null;
  rationaleRef: string | null;
  evaluatorSig: string | null;
  approvalId: string | null;
  settlementTx: string | null;
  poa: PoaRecord | null;
  blockedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface JobDbRow {
  job_id: string;
  owner_addr: string;
  requester_agent_id: string;
  provider_agent_id: string;
  evaluator_agent_id: string;
  status: JobStatus;
  spec: JobSpec;
  job_spec_hash: string;
  requester_sig: string;
  fee_token: string;
  fee_amount_wei: string;
  fee_recipient: string;
  deliverable: Json | null;
  deliverable_root: string | null;
  deliverable_summary: string | null;
  provider_sig: string | null;
  acceptance: AcceptanceResult | null;
  verdict: 'accept' | 'reject' | null;
  rationale_ref: string | null;
  evaluator_sig: string | null;
  approval_id: string | null;
  settlement_tx: string | null;
  poa: PoaRecord | null;
  blocked_by: string | null;
  created_at: string;
  updated_at: string;
}

function toRow(r: JobDbRow): JobRow {
  return {
    jobId: r.job_id,
    ownerAddr: r.owner_addr,
    requesterAgentId: r.requester_agent_id,
    providerAgentId: r.provider_agent_id,
    evaluatorAgentId: r.evaluator_agent_id,
    status: r.status,
    spec: r.spec,
    jobSpecHash: r.job_spec_hash,
    requesterSig: r.requester_sig,
    feeToken: r.fee_token,
    feeAmountWei: r.fee_amount_wei,
    feeRecipient: r.fee_recipient,
    deliverable: r.deliverable,
    deliverableRoot: r.deliverable_root,
    deliverableSummary: r.deliverable_summary,
    providerSig: r.provider_sig,
    acceptance: r.acceptance,
    verdict: r.verdict,
    rationaleRef: r.rationale_ref,
    evaluatorSig: r.evaluator_sig,
    approvalId: r.approval_id,
    settlementTx: r.settlement_tx,
    poa: r.poa,
    blockedBy: r.blocked_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const COLS =
  `job_id, owner_addr, requester_agent_id, provider_agent_id, evaluator_agent_id, status, spec,
   job_spec_hash, requester_sig, fee_token, fee_amount_wei, fee_recipient, deliverable,
   deliverable_root, deliverable_summary, provider_sig, acceptance, verdict, rationale_ref,
   evaluator_sig, approval_id, settlement_tx, poa, blocked_by, created_at, updated_at`;

export interface CreateJobInput {
  jobId: string;
  ownerAddr: string;
  requesterAgentId: string;
  providerAgentId: string;
  evaluatorAgentId: string;
  spec: JobSpec;
  jobSpecHash: string;
  requesterSig: string;
  feeToken: string;
  feeAmountWei: string;
  feeRecipient: string;
}

/** Originate a job (requester side). Status starts at 'originated'. */
export async function createJob(pool: Pool, input: CreateJobInput): Promise<JobRow> {
  const res = await pool.query<JobDbRow>(
    `INSERT INTO jobs (job_id, owner_addr, requester_agent_id, provider_agent_id, evaluator_agent_id,
                       status, spec, job_spec_hash, requester_sig, fee_token, fee_amount_wei, fee_recipient)
     VALUES ($1,$2,$3,$4,$5,'originated',$6,$7,$8,$9,$10,$11)
     RETURNING ${COLS}`,
    [
      input.jobId,
      input.ownerAddr.toLowerCase(),
      input.requesterAgentId,
      input.providerAgentId,
      input.evaluatorAgentId,
      JSON.stringify(input.spec),
      input.jobSpecHash,
      input.requesterSig,
      input.feeToken.toLowerCase(),
      input.feeAmountWei,
      input.feeRecipient.toLowerCase(),
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('createJob failed');
  return toRow(row);
}

export async function getJob(pool: Pool, jobId: string): Promise<JobRow | null> {
  const res = await pool.query<JobDbRow>(`SELECT ${COLS} FROM jobs WHERE job_id = $1`, [jobId]);
  const row = res.rows[0];
  return row ? toRow(row) : null;
}

/**
 * Whether a requester already has a job in flight (not terminal). Origination
 * dedupe: one owner-seeded job runs at a time per requester (the requester
 * executes the ACP lifecycle, it does not spam requests).
 */
export async function hasActiveJob(pool: Pool, requesterAgentId: string): Promise<boolean> {
  const res = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM jobs WHERE requester_agent_id = $1
       AND status NOT IN ('settled','rejected','denied','failed')`,
    [requesterAgentId],
  );
  return Number(res.rows[0]?.n ?? '0') > 0;
}

/** Provider delivery landed + acceptance floor run (requester side). */
export async function recordDelivery(
  pool: Pool,
  jobId: string,
  input: {
    deliverable: Json;
    deliverableRoot: string;
    deliverableSummary: string;
    providerSig: string;
    acceptance: AcceptanceResult;
    status: 'delivered' | 'rejected';
    blockedBy?: string;
  },
): Promise<void> {
  await pool.query(
    `UPDATE jobs SET deliverable = $2, deliverable_root = $3, deliverable_summary = $4,
       provider_sig = $5, acceptance = $6, status = $7, blocked_by = $8, updated_at = now()
     WHERE job_id = $1`,
    [
      jobId,
      JSON.stringify(input.deliverable),
      input.deliverableRoot,
      input.deliverableSummary,
      input.providerSig,
      JSON.stringify(input.acceptance),
      input.status,
      input.blockedBy ?? null,
    ],
  );
}

/** The provider stores its plaintext deliverable so the evaluator can read it. */
export async function recordProviderDeliverable(
  pool: Pool,
  jobId: string,
  input: { deliverable: Json; deliverableRoot: string; deliverableSummary: string; providerSig: string },
): Promise<void> {
  await pool.query(
    `UPDATE jobs SET deliverable = $2, deliverable_root = $3, deliverable_summary = $4,
       provider_sig = $5, updated_at = now() WHERE job_id = $1`,
    [jobId, JSON.stringify(input.deliverable), input.deliverableRoot, input.deliverableSummary, input.providerSig],
  );
}

export async function markEvaluating(pool: Pool, jobId: string): Promise<void> {
  await pool.query(`UPDATE jobs SET status = 'evaluating', updated_at = now() WHERE job_id = $1`, [jobId]);
}

export async function recordVerdict(
  pool: Pool,
  jobId: string,
  input: { verdict: 'accept' | 'reject'; rationaleRef: string; evaluatorSig: string },
): Promise<void> {
  await pool.query(
    `UPDATE jobs SET verdict = $2, rationale_ref = $3, evaluator_sig = $4, status = 'verdict', updated_at = now()
     WHERE job_id = $1`,
    [jobId, input.verdict, input.rationaleRef, input.evaluatorSig],
  );
}

export async function markAwaitingApproval(pool: Pool, jobId: string, approvalId: string): Promise<void> {
  await pool.query(
    `UPDATE jobs SET status = 'awaiting_approval', approval_id = $2, updated_at = now() WHERE job_id = $1`,
    [jobId, approvalId],
  );
}

/**
 * Atomically CLAIM a job for settlement (H-01 double-settle guard). Transitions
 * awaiting_approval → settling ONLY when the approval_id matches the one the
 * owner actually decided. Returns true iff THIS caller won the race — the
 * governed on-chain transfer must fire only on a true return, so a checkpoint
 * replay or a double owner-decide notify cannot pay the fee twice.
 */
export async function claimSettlement(pool: Pool, jobId: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE jobs SET status = 'settling', updated_at = now()
       WHERE job_id = $1 AND status = 'awaiting_approval'`,
    [jobId],
  );
  return (r.rowCount ?? 0) === 1;
}

export async function recordSettlement(
  pool: Pool,
  jobId: string,
  input: { settlementTx: string; poa: PoaRecord },
): Promise<void> {
  // Only a job THIS caller claimed (status='settling') may be marked settled.
  await pool.query(
    `UPDATE jobs SET status = 'settled', settlement_tx = $2, poa = $3, updated_at = now()
       WHERE job_id = $1 AND status = 'settling'`,
    [jobId, input.settlementTx, JSON.stringify(input.poa)],
  );
}

export async function markJobStatus(
  pool: Pool,
  jobId: string,
  status: JobStatus,
  input: { blockedBy?: string; poa?: PoaRecord } = {},
): Promise<void> {
  await pool.query(
    `UPDATE jobs SET status = $2, blocked_by = COALESCE($3, blocked_by),
       poa = COALESCE($4, poa), updated_at = now() WHERE job_id = $1`,
    [jobId, status, input.blockedBy ?? null, input.poa ? JSON.stringify(input.poa) : null],
  );
}

export async function listJobsForOwner(pool: Pool, ownerAddr: string, limit = 50): Promise<JobRow[]> {
  const res = await pool.query<JobDbRow>(
    `SELECT ${COLS} FROM jobs WHERE owner_addr = $1 ORDER BY created_at DESC LIMIT $2`,
    [ownerAddr.toLowerCase(), Math.min(limit, 200)],
  );
  return res.rows.map(toRow);
}
