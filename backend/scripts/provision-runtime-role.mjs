// C-6: one-time Neon-ADMIN step — provision the restricted runtime DB role.
// The app then connects as this role (swap DATABASE_URL on Render/CI); the
// admin URL moves to MIGRATE_DATABASE_URL so boot migrations keep working.
//
//   node scripts/provision-runtime-role.mjs "<ADMIN_DATABASE_URL>" [schema]
//
// What the role can do:  SELECT/INSERT/UPDATE/DELETE on app tables + sequences.
// What it can NOT do:    any DDL (not the schema owner), TRUNCATE anywhere,
//                        UPDATE/DELETE on trace_records (only SELECT/INSERT).
// (UPDATE/DELETE/TRUNCATE on trace_records are ALSO blocked for everyone by
//  the 001/007 triggers — the role is defense-in-depth per PHASE-1-REVIEW C-6.)
//
// ROLLBACK (if the swap breaks the deploy): restore the previous DATABASE_URL
// value on Render/CI — the admin role keeps every grant it had; nothing else
// to undo. The leash_runtime role can be left in place (it grants nothing to
// anyone else) or dropped with: DROP OWNED BY leash_runtime; DROP ROLE leash_runtime;
import { randomBytes } from 'node:crypto';
import pg from 'pg';

const adminUrl = process.argv[2] ?? process.env.DATABASE_URL;
const schema = process.argv[3] ?? 'public';
const ROLE = process.env.RUNTIME_ROLE_NAME ?? 'leash_runtime';
if (!adminUrl) {
  console.error('usage: node scripts/provision-runtime-role.mjs "<ADMIN_DATABASE_URL>" [schema]');
  process.exit(1);
}

const password = randomBytes(24).toString('base64url');
const pool = new pg.Pool({ connectionString: adminUrl, max: 1 });

async function main() {
  const client = await pool.connect();
  try {
    // idempotent create-or-reset
    const exists = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [ROLE]);
    if (exists.rowCount === 0) {
      await client.query(`CREATE ROLE ${ROLE} WITH LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
      console.error(`role ${ROLE} created`);
    } else {
      await client.query(`ALTER ROLE ${ROLE} WITH LOGIN PASSWORD '${password}'`);
      console.error(`role ${ROLE} password rotated`);
    }

    await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${ROLE}`); // usage, NOT create → no DDL
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${ROLE}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${ROLE}`);
    // trace_records: append-only for the app role at the GRANT layer too
    await client.query(`REVOKE UPDATE, DELETE, TRUNCATE ON trace_records FROM ${ROLE}`);
    // future tables created by admin-run migrations inherit app grants
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ROLE}`,
    );
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT USAGE, SELECT ON SEQUENCES TO ${ROLE}`);

    const u = new URL(adminUrl);
    u.username = ROLE;
    u.password = password;
    console.log('\nRuntime DATABASE_URL (set on Render/CI; keep the admin URL as MIGRATE_DATABASE_URL):');
    console.log(u.toString());
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error('provision failed:', e.message);
  process.exit(1);
});
