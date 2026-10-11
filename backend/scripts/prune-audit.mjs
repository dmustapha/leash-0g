// SCOPE-I-6: operator-run audit PRUNE — delete trace_records / owner_records
// rows already archived to 0G (seq <= last_batched_seq) AND older than the
// retention window, WITHOUT breaking hash-chain verification. The deleted
// prefix is anchored by audit_prune_checkpoint (written atomically with the
// delete) so full verification resumes from the checkpoint instead of genesis.
//
//   # DRY-RUN (default — prints per-key counts + cutoff, deletes NOTHING):
//   cd backend && npx tsx scripts/prune-audit.mjs
//   # APPLY (destructive — actually deletes):
//   cd backend && AUDIT_RETENTION_DAYS=90 npx tsx scripts/prune-audit.mjs --apply
//
// Runs as ADMIN (MIGRATE_DATABASE_URL ?? DATABASE_URL) — only the admin role can
// DISABLE TRIGGER; the restricted runtime role can never prune (INFRA-1). It is
// IDEMPOTENT (a re-run finds the rows gone, deletes 0) and NEVER touches
// audit_batches / audit_cursor / owner_audit_cursor — pruning only removes
// chain rows, the 0G batch metadata stays intact.
import pg from 'pg';
import { loadConfig } from '../src/config.js';
import {
  computeCutoffs,
  pruneStream,
  TRACE_TABLES,
  OWNER_TABLES,
} from '../src/store/audit-prune.js';

const DEFAULT_RETENTION_DAYS = 90;
// Floor so a fat-fingered AUDIT_RETENTION_DAYS=0 can't nuke every batched row
// seconds after it lands (retention=0 ⇒ created_at < now() ⇒ everything old).
const MIN_RETENTION_DAYS = 1;

const cfg = loadConfig();
const connectionString = cfg.MIGRATE_DATABASE_URL ?? cfg.DATABASE_URL;
const retentionDays = Number(process.env['AUDIT_RETENTION_DAYS'] ?? DEFAULT_RETENTION_DAYS);
const apply = process.argv.includes('--apply');

if (!Number.isFinite(retentionDays) || retentionDays < MIN_RETENTION_DAYS) {
  console.error(
    `AUDIT_RETENTION_DAYS must be a number >= ${MIN_RETENTION_DAYS}, got: ${process.env['AUDIT_RETENTION_DAYS']}`,
  );
  process.exit(1);
}

const pool = new pg.Pool({ connectionString, max: 1 });

async function runStream(client, t) {
  const plans = await computeCutoffs(client, t, retentionDays);
  if (plans.length === 0) {
    console.log(`[${t.stream}] nothing eligible`);
    return { deleted: 0, keys: 0 };
  }
  let deleted = 0;
  for (const plan of plans) {
    if (!apply) {
      console.log(
        `[${t.stream}] DRY-RUN ${plan.key}: would prune ${plan.eligibleRows} rows (seq <= ${plan.cutoffSeq})`,
      );
      continue;
    }
    const res = await pruneStream(client, t, plan);
    deleted += res.deleted;
    console.log(
      `[${t.stream}] ${res.key}: deleted ${res.deleted} rows (seq <= ${res.cutoffSeq}), checkpoint seq=${res.checkpointSeq}`,
    );
  }
  return { deleted, keys: plans.length };
}

async function main() {
  console.log(
    `audit prune: mode=${apply ? 'APPLY' : 'DRY-RUN'} retention=${retentionDays}d`,
  );
  const client = await pool.connect();
  let totals = { deleted: 0, keys: 0 };
  try {
    for (const t of [TRACE_TABLES, OWNER_TABLES]) {
      const r = await runStream(client, t);
      totals.deleted += r.deleted;
      totals.keys += r.keys;
    }
  } finally {
    client.release();
    await pool.end();
  }
  console.log(
    `audit prune complete: ${apply ? `deleted ${totals.deleted} rows across` : 'would prune'} ${totals.keys} key(s)`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
