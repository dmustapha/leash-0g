import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';

export interface TestDb {
  pool: Pool;
  schema: string;
  drop: () => Promise<void>;
}

/** Hermetic per-test-run schema on the real (Neon) DATABASE_URL — spec test plan. */
export async function createTestDb(): Promise<TestDb> {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL required for integration tests');
  const schema = `test_${randomBytes(6).toString('hex')}`;
  const admin = createPool(url);
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const pool = createPool(url, schema);
  await migrate(pool);
  return {
    pool,
    schema,
    drop: async () => {
      await pool.end();
      const cleanup = createPool(url);
      await cleanup.query(`DROP SCHEMA ${schema} CASCADE`);
      await cleanup.end();
    },
  };
}

export interface SeedAgentOptions {
  tokenId?: string;
  tokenHash?: string;
  ownerAddr?: string;
  accountAddr?: string;
  sessionKeyAddr?: string;
  sessionKeyEnc?: string;
  auditPubkey?: string;
  status?: 'active' | 'revoked';
  gatewayRules?: unknown[];
  goal?: Record<string, unknown>;
  name?: string;
  gatewayTokenEnc?: string;
}

export async function seedAgent(pool: Pool, opts: SeedAgentOptions = {}): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO agents (owner_addr, account_addr, session_key_addr, session_key_enc, audit_pubkey,
                         token_id, token_hash, name, status, gateway_rules, goal, gateway_token_enc)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [
      (opts.ownerAddr ?? '0x' + 'a1'.repeat(20)).toLowerCase(),
      (opts.accountAddr ?? '0x' + 'b2'.repeat(20)).toLowerCase(),
      (opts.sessionKeyAddr ?? '0x' + 'c3'.repeat(20)).toLowerCase(),
      opts.sessionKeyEnc ?? 'enc',
      opts.auditPubkey ?? '02' + 'd4'.repeat(32),
      opts.tokenId ?? randomBytes(8).toString('hex'),
      opts.tokenHash ?? 'unset',
      opts.name ?? 'test-agent',
      opts.status ?? 'active',
      JSON.stringify(opts.gatewayRules ?? []),
      JSON.stringify(opts.goal ?? {}),
      opts.gatewayTokenEnc ?? null,
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('seedAgent failed');
  return row.id;
}
