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

/**
 * The DB URL integration tests build their hermetic per-run schema on. TI-1: the
 * DEFAULT suite (`vitest run`) should NOT hit Neon — a full-parallel run deadlocks
 * the shared Neon instance. Prefer TEST_DATABASE_URL (a LOCAL Postgres, e.g.
 * `postgres://postgres:postgres@localhost:5432/leash_test`), then a `localhost`
 * default, falling back to DATABASE_URL only when a test explicitly points there
 * (the live suite). A non-local DATABASE_URL with no TEST_DATABASE_URL set is a
 * loud error so the default suite can never silently run against Neon.
 */
const LOCAL_TEST_DB_DEFAULT = 'postgres://postgres:postgres@localhost:5432/leash_test';

export function resolveTestDbUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['TEST_DATABASE_URL'];
  if (explicit) return explicit;
  const dbUrl = env['DATABASE_URL'];
  // A LOCAL DATABASE_URL is fine to reuse; a remote one must opt in via TEST_DATABASE_URL.
  if (dbUrl && /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(dbUrl)) return dbUrl;
  if (!dbUrl) return LOCAL_TEST_DB_DEFAULT;
  throw new Error(
    'DATABASE_URL points at a non-local host; set TEST_DATABASE_URL to a local Postgres for the default (hermetic) suite',
  );
}

/** Hermetic per-test-run schema on a LOCAL Postgres (TI-1), or an opt-in remote URL. */
export async function createTestDb(): Promise<TestDb> {
  const url = resolveTestDbUrl();
  if (!url) throw new Error('no test database URL resolved (set TEST_DATABASE_URL)');
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
  /** SE-5: the chain this agent lives on — defaults to 0G Galileo (16602). */
  chainId?: number;
}

export async function seedAgent(pool: Pool, opts: SeedAgentOptions = {}): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO agents (owner_addr, account_addr, session_key_addr, session_key_enc, audit_pubkey,
                         token_id, token_hash, name, status, gateway_rules, goal, gateway_token_enc, chain_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [
      (opts.ownerAddr ?? '0x' + 'a1'.repeat(20)).toLowerCase(),
      // SE-6 pre-req: default account address is RANDOM per seed — migration 021's
      // UNIQUE(owner_addr, chain_id, account_addr) forbids two agents of the same
      // owner sharing an address on a chain. Tests that need a specific/shared
      // address pass accountAddr explicitly (cross-chain / cross-owner cases).
      (opts.accountAddr ?? '0x' + randomBytes(20).toString('hex')).toLowerCase(),
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
      opts.chainId ?? 16602,
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('seedAgent failed');
  // SCOPE-RH2-2: mirror insertAgent — seed the key history at seq 0 so the
  // seeded agent's audit key covers its trace from the first record.
  const auditPubkey = opts.auditPubkey ?? '02' + 'd4'.repeat(32);
  await pool.query(
    `INSERT INTO agent_audit_keys (agent_id, pubkey, effective_from_seq) VALUES ($1, $2, 0)
     ON CONFLICT (agent_id, effective_from_seq) DO NOTHING`,
    [row.id, auditPubkey],
  );
  return row.id;
}
