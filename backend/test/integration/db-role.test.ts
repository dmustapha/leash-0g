import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { createPool } from '../../src/db/pool.js';
import { appendTrace } from '../../src/trace/trace-store.js';
import { sweepOrphanedApprovals } from '../../src/approvals/sweep.js';
import { createApproval } from '../../src/store/approvals.js';

let db: TestDb;
let rolePool: Pool | null = null;

const SCRIPT = fileURLToPath(new URL('../../scripts/provision-runtime-role.mjs', import.meta.url));

beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

afterAll(async () => {
  await rolePool?.end();
  await db.drop();
});

describe('C-6 trace hardening (migration 007 + restricted role + startup sweep)', () => {
  it('BEFORE TRUNCATE trigger blocks TRUNCATE for everyone — admin included', async () => {
    const agentId = await seedAgent(db.pool);
    await appendTrace(db.pool, { agentId, kind: 'decision', detail: { summary: 'pre-truncate' } });
    await expect(db.pool.query('TRUNCATE trace_records')).rejects.toThrow(/append-only/);
    const rows = await db.pool.query('SELECT count(*) AS n FROM trace_records');
    expect(Number(rows.rows[0].n)).toBeGreaterThan(0);
  });

  it('provision script creates a runtime role that can run the app but not mutate history or DDL', async () => {
    const url = process.env['DATABASE_URL']!;
    // Test-scoped role name — never rotate the real runtime role's password
    // from CI (the cluster is shared with the deployed stack).
    const out = execFileSync(process.execPath, [SCRIPT, url, db.schema], {
      env: { ...process.env, RUNTIME_ROLE_NAME: 'leash_runtime_test' },
      encoding: 'utf8',
    });
    const runtimeUrl = out.trim().split('\n').at(-1)!;
    expect(runtimeUrl).toContain('leash_runtime_test');

    rolePool = createPool(runtimeUrl, db.schema);

    // Normal app queries WORK as the role (the whole suite's operations in miniature).
    const agentRes = await rolePool.query(
      `INSERT INTO agents (owner_addr, account_addr, session_key_addr, session_key_enc, audit_pubkey,
                           token_id, token_hash, name, gateway_rules, goal)
       VALUES ('0xaa','0xbb','0xcc','enc','02dd','tok-role','hash','role-test','[]','{}') RETURNING id`,
    );
    const agentId = agentRes.rows[0].id as string;
    await appendTrace(rolePool, { agentId, kind: 'decision', detail: { summary: 'as-role append' } });
    const read = await rolePool.query('SELECT count(*) AS n FROM trace_records WHERE agent_id = $1', [agentId]);
    expect(Number(read.rows[0].n)).toBe(1);
    await rolePool.query(`UPDATE agents SET status = 'revoked' WHERE id = $1`, [agentId]);

    // trace_records: UPDATE / DELETE / TRUNCATE all denied at the GRANT layer.
    await expect(rolePool.query(`UPDATE trace_records SET kind = 'forged' WHERE agent_id = $1`, [agentId]))
      .rejects.toThrow(/permission denied|append-only/);
    await expect(rolePool.query(`DELETE FROM trace_records WHERE agent_id = $1`, [agentId]))
      .rejects.toThrow(/permission denied|append-only/);
    await expect(rolePool.query('TRUNCATE trace_records')).rejects.toThrow(/permission denied|append-only/);

    // No DDL: not the schema owner, USAGE only.
    await expect(rolePool.query('CREATE TABLE sneaky (id int)')).rejects.toThrow(/permission denied/);
    await expect(rolePool.query('DROP TABLE trace_records')).rejects.toThrow(/must be owner|permission denied/);
    await expect(rolePool.query('ALTER TABLE trace_records DISABLE TRIGGER ALL')).rejects.toThrow(
      /must be owner|permission denied/,
    );
  }, 60_000);

  it('startup sweep expires orphaned pending approvals chain-visibly', async () => {
    const agentId = await seedAgent(db.pool);
    const orphan = await createApproval(db.pool, agentId, { held: 'request' });
    const traces = await sweepOrphanedApprovals(db.pool);

    const row = await db.pool.query(`SELECT state FROM approvals WHERE id = $1`, [orphan.id]);
    expect(row.rows[0].state).toBe('expired');
    const consent = traces.find((t) => t.approvalId === orphan.id);
    expect(consent?.kind).toBe('consent');
    expect(consent?.decision).toBe('expired');
    expect(consent?.decidedBy).toBe('system');

    // Idempotent: nothing pending → nothing swept.
    expect(await sweepOrphanedApprovals(db.pool)).toHaveLength(0);
  });
});
