import type { Pool } from 'pg';

/**
 * INFRA-1: the append-only audit guarantee on `trace_records` (the 001/007
 * UPDATE/DELETE/TRUNCATE triggers) is only ENFORCED if the runtime DB role
 * cannot bypass it. The table owner / admin can `ALTER TABLE … DISABLE TRIGGER`
 * then TRUNCATE, so a process running on the admin credential makes the
 * tamper-evidence guarantee VACUOUS — and nothing else surfaces that misconfig.
 *
 * TRUNCATE privilege is the discriminator: the restricted runtime role
 * (`scripts/provision-runtime-role.mjs`) is explicitly NOT granted it and is not
 * the table owner, so it returns false; an owner/admin connection returns true.
 * (has_table_privilege reflects the GRANT/ownership, independent of the trigger
 * that blocks the action — exactly what we want to detect.)
 */
// Note: has_table_privilege returns true for superusers too — correctly flagged.
// A non-owner role with CREATEROLE that could self-grant TRUNCATE is out of scope
// (that role is already admin-equivalent by any measure).
export async function runtimeRoleCanBypassAudit(pool: Pool): Promise<boolean> {
  const res = await pool.query<{ can: boolean }>(
    `SELECT has_table_privilege(current_user, 'trace_records', 'TRUNCATE') AS can`,
  );
  // Fail LOUD, never silent: a missing table throws at the Postgres layer, but
  // guard the no-rows case explicitly so a future refactor can't swallow an
  // audit-integrity check into a false "cannot bypass".
  const row = res.rows[0];
  if (!row) throw new Error('[INFRA-1] trace_records audit-role check returned no rows');
  return row.can === true;
}
