import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  // C-6: when the app runs as the restricted runtime role, boot migrations
  // (DDL) need the admin connection — set this to the Neon admin URL. Unset =
  // migrate over DATABASE_URL (admin-URL setups, tests).
  MIGRATE_DATABASE_URL: z.string().min(1).optional(),
  ZERO_G_COMPUTE_API_KEY: z.string().min(1),
  ZERO_G_RPC: z.string().url(),
  ZERO_G_CHAIN_ID: z.coerce.number().int().positive(),
  ZERO_G_STORAGE_INDEXER: z.string().url(),
  OPS_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  OPS_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  // C-1: dedicated guardian key — revoke-ONLY signer with its own nonce space,
  // so incident response never queues behind creates. Gas-dust-funded; grants
  // nothing (non-custodial invariant unchanged, spec §3b / 07 S5).
  GUARDIAN_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  GUARDIAN_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  PRIVY_APP_ID: z.string().min(1),
  PRIVY_APP_SECRET: z.string().min(1),
  KEY_ENCRYPTION_SECRET: z.string().regex(/^[0-9a-fA-F]{64}$/),
  AGENT_REGISTRY_ADDR: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  LEASH_FACTORY_ADDR: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().min(1).default('127.0.0.1'), // M-01 dev bind; Render sets 0.0.0.0
  // M-01: the gateway listens on its OWN server, always bound to 127.0.0.1 —
  // it must never share the public HOST:PORT surface.
  GATEWAY_PORT: z.coerce.number().int().positive().default(8081),
  COMPUTE_BASE_URL: z.string().url().default('https://router-api.0g.ai/v1'),
  // S11 (rev-2): raised 180s → 600s — a Telegram push answered from a phone
  // must be able to land inside the deny-by-default window (00 §1a "act from
  // the notification"); semantics (deny-by-default, C-3 rendezvous) unchanged.
  APPROVAL_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  SESSION_GAS_DUST_WEI: z.string().regex(/^\d{1,30}$/).default('2000000000000000'), // 0.002 0G
  DEFAULT_TIMELOCK_DELAY: z.coerce.number().int().nonnegative().default(900),
  RUNTIME_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  // 0G's own model as the Phase-1 default (Dami 2026-09-20): 0G agents reason on
  // 0G's in-house model. It is a REASONING model (emits reasoning_content before
  // content, PHASE-0 §2) — prompt.ts keeps max_tokens ≥256 and falls back to
  // reasoning_content when content is starved. goal.model overrides per agent;
  // revisit at Phase 4 (real-job slice).
  RUNTIME_DEFAULT_MODEL: z.string().min(1).default('0gm-1.0-35b-a3b'),
  // C-1 limits (07 S6, config-driven testnet defaults; revisit at first
  // external users / mainnet). Quota counts ALL created rows incl. revoked —
  // ops create-gas is the drained resource; revoking must not refill quota.
  CREATE_QUOTA_PER_OWNER: z.coerce.number().int().positive().default(10),
  CREATE_RATE_PER_HOUR: z.coerce.number().int().positive().default(5),
  // P3C-1 (07 S11): a create reservation past this age counts as dead (its
  // create evidently crashed) — quota/rate ignore it and the sweep releases it.
  RESERVATION_TTL_MS: z.coerce.number().int().positive().default(120_000),
  // P3C-5 (07 S11): GET /api/agents balance fan-out is N live RPC reads per
  // request — an authed amplification surface. Short per-account cache bounds
  // it; the agent DETAIL view keeps live reads (freshness where it matters).
  BALANCE_CACHE_TTL_MS: z.coerce.number().int().positive().default(15_000),
  // Phase-3 daily loop (07 S11, config-driven testnet values).
  ALERT_RATE_PER_OWNER_PER_HOUR: z.coerce.number().int().positive().default(60),
  DIGEST_DEFAULT_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(8),
  // Telegram (S9) — the whole feature is OFF unless the token is set (local
  // dev / CI run without a bot; the deployed stack sets all four).
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16).optional(),
  TELEGRAM_BOT_USERNAME: z.string().min(1).optional(),
  PUBLIC_BASE_URL: z.string().url().optional(),
  ALLOWLIST_MAX: z.coerce.number().int().positive().default(16),
  RULES_MAX: z.coerce.number().int().positive().default(32),
  // Coordination channel bounds (spec §3b): zero-authority contains SPENDING,
  // not resource burn — a hijacked A could still spam envelopes (compute-burn
  // on B + approval-fatigue on supervised links). These caps bound that
  // surface; all config-driven testnet defaults (07 S6 revisit trigger).
  DELEGATION_TTL_MS: z.coerce.number().int().positive().default(600_000),
  DELEGATION_RATE_PER_LINK_PER_HOUR: z.coerce.number().int().positive().default(12),
  DELEGATION_MAX_PENDING_PER_LINK: z.coerce.number().int().positive().default(3),
  DELEGATION_PAYLOAD_MAX_BYTES: z.coerce.number().int().positive().default(16_384),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    // Never echo values — names only.
    throw new Error(`Invalid environment configuration: ${missing}`);
  }
  return parsed.data;
}
