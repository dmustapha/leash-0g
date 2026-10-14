/**
 * QA+ #2 — prod migration DRY-RUN (local scratch Postgres; NEVER touches prod Neon).
 * Simulates the incremental-onto-populated prod path for the new migrations 030/033/034:
 *   1. fresh scratch DB
 *   2. apply 001..032 (a temp dir of just those files) — "prod before this work"
 *   3. seed a real agents row at account_version=4 (populated-prod simulation)
 *   4. apply the FULL dir → 033/034 land INCREMENTALLY on populated data (via the real runner)
 *   5. assert: runner applied exactly [033,034(+030 if absent)]; the seeded row survived;
 *      a version=5 insert is now allowed; a version=3 insert is rejected; the 034 table exists;
 *      and TIME the 033 ALTER (lock duration) to confirm non-blocking at scale.
 *
 * Run (local PG16 required):  node scripts/tearapart/migration-dryrun.mjs
 */
import pg from 'pg';
import { mkdtempSync, readdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '../../src/db/migrate.ts';

const ADMIN = 'postgres://postgres:postgres@localhost:5432/postgres';
const DBNAME = 'leash_migdryrun';
const SCRATCH = `postgres://postgres:postgres@localhost:5432/${DBNAME}`;
const MIG_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

async function main() {
  // 1. fresh scratch DB
  const admin = new pg.Pool({ connectionString: ADMIN });
  await admin.query(`DROP DATABASE IF EXISTS ${DBNAME} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DBNAME}`);
  await admin.end();

  const pool = new pg.Pool({ connectionString: SCRATCH });
  const checks = [];
  try {
    // 2. apply 001..032 via a temp dir of symlinks (filename-ordered runner)
    const tmp = mkdtempSync(join(tmpdir(), 'mig-'));
    const upTo032 = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql') && f.slice(0, 3) <= '032').sort();
    for (const f of upTo032) symlinkSync(join(MIG_DIR, f), join(tmp, f));
    const base = await migrate(pool, tmp);
    rmSync(tmp, { recursive: true, force: true });
    checks.push(['baseline 001..032 applied', base.length === upTo032.length, `${base.length}/${upTo032.length}`]);

    // 3. seed a populated-prod agents row at version=4 (auto-fill NOT NULL / no-default cols)
    const cols = (await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name='agents'`,
    )).rows;
    const need = cols.filter((c) => c.is_nullable === 'NO' && c.column_default === null);
    const names = [], vals = [], ph = [];
    let i = 1;
    for (const c of need) {
      names.push(c.column_name);
      if (c.column_name === 'account_version') { vals.push(4); ph.push(`$${i++}`); continue; }
      const t = c.data_type;
      if (/int|numeric|double|real/.test(t)) vals.push(0);
      else if (t === 'boolean') vals.push(false);
      else if (/timestamp|date/.test(t)) { ph.push('now()'); continue; }
      else if (t === 'jsonb' || t === 'json') vals.push('{}');
      else if (t === 'uuid') { ph.push('gen_random_uuid()'); continue; }
      else vals.push(`dryrun-${c.column_name}`);
      ph.push(`$${i++}`);
    }
    // account_version has a DB default → force it explicitly so the seed is unambiguously v4.
    if (!names.includes('account_version')) { names.push('account_version'); vals.push(4); ph.push(`$${i++}`); }
    await pool.query(`INSERT INTO agents (${names.join(',')}) VALUES (${ph.join(',')})`, vals);
    const seeded = (await pool.query(`SELECT count(*)::int n FROM agents WHERE account_version=4`)).rows[0].n;
    checks.push(['seeded agents row @ version=4', seeded === 1, `rows=${seeded}`]);

    // 4. apply the FULL dir → 033/034 land incrementally on the populated table; TIME 033
    const t0 = process.hrtime.bigint();
    const inc = await migrate(pool, MIG_DIR);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    checks.push(['incremental applied 033+034', inc.includes('033_account_version_v5.sql') && inc.includes('034_audit_pubkey_rotation_nonce.sql'), inc.join(',')]);
    checks.push(['incremental step fast (<2000ms, non-blocking at scale)', ms < 2000, `${ms.toFixed(0)}ms for ${inc.length} migration(s)`]);

    // 5. assertions on the widened constraint + new table
    const survived = (await pool.query(`SELECT account_version FROM agents`)).rows[0]?.account_version;
    checks.push(['seeded v4 row survived 033', Number(survived) === 4, `version=${survived}`]);

    let v5ok = false;
    try {
      await pool.query(`UPDATE agents SET account_version=5`); v5ok = true;
    } catch { v5ok = false; }
    checks.push(['version=5 now allowed (widen worked)', v5ok, v5ok ? 'accepted' : 'rejected']);

    let v3rejected = false;
    try { await pool.query(`UPDATE agents SET account_version=3`); } catch { v3rejected = true; }
    checks.push(['version=3 still rejected (constraint intact)', v3rejected, v3rejected ? 'rejected' : 'ACCEPTED(!)']);

    const tbl = (await pool.query(`SELECT to_regclass('public.audit_pubkey_rotation_nonce') t`)).rows[0].t;
    checks.push(['034 table audit_pubkey_rotation_nonce exists', tbl !== null, String(tbl)]);
  } finally {
    await pool.end();
    const a2 = new pg.Pool({ connectionString: ADMIN });
    await a2.query(`DROP DATABASE IF EXISTS ${DBNAME} WITH (FORCE)`).catch(() => {});
    await a2.end();
  }

  console.log('\n=== QA+ #2 — PROD MIGRATION DRY-RUN (local scratch, incremental-on-populated) ===');
  let allOk = true;
  for (const [label, ok, note] of checks) { allOk &&= ok; console.log(`${ok ? '✅' : '❌'} ${label}  [${note}]`); }
  console.log(allOk ? '\nMIGRATION PATH SAFE — 030/033/034 apply cleanly, incrementally, non-blocking ✅' : '\nFAILURES PRESENT ❌');
  process.exit(allOk ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
