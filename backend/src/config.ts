import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  ZERO_G_COMPUTE_API_KEY: z.string().min(1),
  ZERO_G_RPC: z.string().url(),
  ZERO_G_CHAIN_ID: z.coerce.number().int().positive(),
  ZERO_G_STORAGE_INDEXER: z.string().url(),
  OPS_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  OPS_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  PRIVY_APP_ID: z.string().min(1),
  PRIVY_APP_SECRET: z.string().min(1),
  KEY_ENCRYPTION_SECRET: z.string().regex(/^[0-9a-fA-F]{64}$/),
  AGENT_REGISTRY_ADDR: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  LEASH_FACTORY_ADDR: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().min(1).default('127.0.0.1'), // M-01 dev bind; Render sets 0.0.0.0
  COMPUTE_BASE_URL: z.string().url().default('https://router-api.0g.ai/v1'),
  APPROVAL_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
  SESSION_GAS_DUST_WEI: z.string().regex(/^\d{1,30}$/).default('2000000000000000'), // 0.002 0G
  DEFAULT_TIMELOCK_DELAY: z.coerce.number().int().nonnegative().default(900),
  RUNTIME_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  // 0G's own model as the Phase-1 default (Dami 2026-09-20): 0G agents reason on
  // 0G's in-house model. It is a REASONING model (emits reasoning_content before
  // content, PHASE-0 §2) — prompt.ts keeps max_tokens ≥256 and falls back to
  // reasoning_content when content is starved. goal.model overrides per agent;
  // revisit at Phase 4 (real-job slice).
  RUNTIME_DEFAULT_MODEL: z.string().min(1).default('0gm-1.0-35b-a3b'),
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
