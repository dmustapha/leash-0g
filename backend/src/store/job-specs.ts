import type { Pool } from 'pg';
import type { JobSpec } from '../jobs/envelopes.js';
import type { AcceptanceRuleSet } from '../jobs/acceptance.js';

/**
 * The owner-seeded job spec registry (spec §5, F5). The operator defines the
 * job a requester runs; the requester EXECUTES it, never invents the question
 * (autonomous need-detection is deferred). `RequesterGoal.jobSpecSource` is the
 * opaque handle into this table. The acceptance rule set (F2) and the fee
 * amount (F4) travel with the spec so BOTH resolve from server state — never
 * from model or envelope text. This is authority: the runtime reads it, the
 * model never writes it.
 */

export interface OwnerJobSpec {
  spec: JobSpec;
  acceptance: AcceptanceRuleSet;
  feeAmountWei: string;
}

export async function upsertJobSpec(
  pool: Pool,
  ownerAddr: string,
  sourceRef: string,
  value: OwnerJobSpec,
): Promise<void> {
  await pool.query(
    `INSERT INTO job_specs (owner_addr, source_ref, spec, acceptance, fee_amount_wei)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (owner_addr, source_ref)
     DO UPDATE SET spec = EXCLUDED.spec, acceptance = EXCLUDED.acceptance,
                   fee_amount_wei = EXCLUDED.fee_amount_wei, updated_at = now()`,
    [
      ownerAddr.toLowerCase(),
      sourceRef,
      JSON.stringify(value.spec),
      JSON.stringify(value.acceptance),
      value.feeAmountWei,
    ],
  );
}

export async function getJobSpec(
  pool: Pool,
  ownerAddr: string,
  sourceRef: string,
): Promise<OwnerJobSpec | null> {
  const res = await pool.query<{ spec: JobSpec; acceptance: AcceptanceRuleSet; fee_amount_wei: string }>(
    `SELECT spec, acceptance, fee_amount_wei FROM job_specs WHERE owner_addr = $1 AND source_ref = $2`,
    [ownerAddr.toLowerCase(), sourceRef],
  );
  const row = res.rows[0];
  if (!row) return null;
  return { spec: row.spec, acceptance: row.acceptance, feeAmountWei: row.fee_amount_wei };
}
