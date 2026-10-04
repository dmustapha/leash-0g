import { z } from 'zod';
import type { ChainConfig } from './chain/registry.js';

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
  // SE-1 (Stage E): the dedicated V4 (governed-calldata) factory. Governed
  // agents (accountVersion=4, the create default) are minted here. Optional so
  // legacy-only setups still boot; a V4 create with this unset fails loudly
  // rather than silently minting a legacy account. BR-1: swapping in the SE-6
  // deterministic CREATE2 factory is a change to this address alone.
  LEASH_FACTORY_V4_ADDR: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
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
  // Phase-4 §0.6 + F8: the ACP provider/evaluator work cycles use STRONGER
  // 0G-catalog models than the platform default (0gm-1.0 flaked on structured
  // output in Phase 3), and the evaluator's model MUST DIFFER from the
  // provider's so verification does not inherit the provider's blind spots
  // (perspective diversity). Confirmed available via the 0G router GET /models.
  // goal.model still overrides per agent; the requester never reasons so it
  // needs no strong model.
  JOB_PROVIDER_MODEL: z.string().min(1).default('deepseek-v3'),
  JOB_EVALUATOR_MODEL: z.string().min(1).default('glm-5'),
  // Phase-5 (D-B1): the create-funnel spec-elevation model. Runs on LEASH's
  // Compute key (create-time cost deferred, 07 #6), NOT agent-keyed. Defaults to
  // a capable 0G-catalog model already confirmed available via the router GET
  // /models (deepseek-v3, same as the provider). goal.model does not apply —
  // this is an owner create-time call, not a runtime agent.
  ELEVATION_MODEL: z.string().min(1).default('deepseek-v3'),
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
  // P4C-1 (07, recurring MEDIUM since Phase 1 — before real funds): the single
  // Render instance's SSE fan-out is unbounded, so one authed owner opening
  // many streams can exhaust file descriptors / heap. Cap connections globally
  // AND per owner, and reap idle/zombie sockets via a heartbeat write (a dead
  // peer's socket fails the write and is closed). Config-driven testnet
  // defaults; revisit at first external users / mainnet (same as S6/S11).
  SSE_MAX_GLOBAL: z.coerce.number().int().positive().default(400),
  SSE_MAX_PER_OWNER: z.coerce.number().int().positive().default(20),
  SSE_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  DIGEST_DEFAULT_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(8),
  // Telegram (S9) — the whole feature is OFF unless the token is set (local
  // dev / CI run without a bot; the deployed stack sets all four).
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16).optional(),
  TELEGRAM_BOT_USERNAME: z.string().min(1).optional(),
  PUBLIC_BASE_URL: z.string().url().optional(),
  // Stage D (spec §3b): the FRONTEND base URL used to build the JIT
  // capability-request deep-link on the Telegram card (opens the app so the
  // owner can sign the on-chain grant — never a tap-to-grant here). Optional:
  // unset ⇒ the card is delivered without a link (still legible + actionable
  // in-app), so local/CI without a web deploy still boots.
  WEB_APP_URL: z.string().url().optional(),
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
  // Phase 5.6 chaining bounds (spec §5; config-driven testnet defaults, 07 S6).
  CHAIN_MAX_DEPTH: z.coerce.number().int().positive().max(16).default(3),
  CHAIN_MAX_ELIGIBLE_PER_HOP: z.coerce.number().int().positive().max(16).default(3),
  // Stage D governed-calldata (spec §5, config-driven testnet defaults, 07 S6).
  // The per-network TARGET CATALOG (decision (c)): logical preset keys
  // (router/vault/settlement_token) → the deployed MOCK target addresses on 0G
  // testnet (DEPLOYMENTS.md "Stage D"). Real protocols are Stage E. Optional so
  // local/CI without a deployment still boots (preset resolve just returns
  // unresolvable_target — never a partial grant).
  CAP_ROUTER_ADDR: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  CAP_VAULT_ADDR: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  CAP_SETTLEMENT_TOKEN_ADDR: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  // How long a JIT (L2) capability card stays actionable before it auto-expires
  // (the sweep resolves it). Reuses the approval-timeout posture as the default.
  JIT_TTL_MS: z.coerce.number().int().positive().default(600_000),
  // SE-7 (E-7): Base Sepolia — the first REAL second chain. The entry is
  // config-only (SE-5's promise): setting BOTH env vars onboards the chain; no
  // code fork. The V4 factory is the SAME deterministic CREATE2 address on
  // every chain (SD-E9), so it reuses LEASH_FACTORY_V4_ADDR. There is NO legacy
  // v2 factory on Base — legacy creates on Base fail loudly (default-deny).
  BASE_SEPOLIA_RPC: z.string().url().optional(),
  AGENT_REGISTRY_BASE_ADDR: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  // Real deployed protocol targets on Base Sepolia (SE-7): router = Uniswap
  // SwapRouter02, vault = Aave stataWETH (ERC-4626 over aWETH — exposes the
  // structured deposit(uint256,address) wall decoder), settlementToken = USDC.
  BASE_CAP_ROUTER_ADDR: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  BASE_CAP_VAULT_ADDR: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  BASE_CAP_SETTLEMENT_TOKEN_ADDR: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  // Comma-separated allowlisted REAL protocol contracts on Base Sepolia
  // (Uniswap router / Permit2 / Aave stata vault / WETH / USDC).
  BASE_PROTOCOL_ALLOWLIST: z.string().optional(),
  /**
   * SE-8: allowlisted bridges on Base Sepolia, `bridgeAddr:destinationChainId`
   * comma-list (e.g. the OP-stack L2StandardBridge → Ethereum Sepolia:
   * `0x4200000000000000000000000000000000000010:11155111`). Fail-loud parse.
   */
  BASE_BRIDGE_ALLOWLIST: z.string().optional(),
  /** SE-8: bridge DESTINATION chain (same-address verification substrate). */
  ETHEREUM_SEPOLIA_RPC: z.string().url().optional(),
  AGENT_REGISTRY_SEPOLIA_ADDR: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  // SE-9 (E-10): Arbitrum Sepolia (421614) — the DIVERGENT-bridge chain. Config-only
  // onboarding (SE-5's promise): setting BOTH vars registers the chain, no code fork.
  // The V4 factory is the SAME deterministic CREATE2 address everywhere (SD-E9), so
  // it reuses LEASH_FACTORY_V4_ADDR. Default-deny while unset (E-11).
  ARBITRUM_SEPOLIA_RPC: z.string().url().optional(),
  AGENT_REGISTRY_ARBITRUM_ADDR: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  /**
   * SE-9: allowlisted Arbitrum bridges, `bridgeAddr:destChainId` comma-list — the L2
   * GatewayRouter (`outboundTransfer`) and ArbSys (`withdrawEth`), both → Ethereum
   * Sepolia (11155111). Fail-loud parse (L-03).
   */
  ARB_BRIDGE_ALLOWLIST: z.string().optional(),
  /** Comma-separated allowlisted protocol contracts on Arbitrum Sepolia (e.g. the L2 ERC-20 gateway the approve leg targets). */
  ARB_PROTOCOL_ALLOWLIST: z.string().optional(),
  /** SE-9: a bridgeable test ERC-20 on Arb Sepolia (localToken, the L2 asset that moves). */
  ARB_CAP_BRIDGE_TOKEN_L2: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  /** SE-9: its Ethereum-Sepolia (L1) counterpart — the `outboundTransfer` arg0 (remote token). */
  ARB_CAP_BRIDGE_TOKEN_L1: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  // SE-10 (E-11): PROMOTE Ethereum Sepolia (11155111) from a bridge DESTINATION-only
  // chain (SE-8) to a FULL governed HOME chain — a home-on-Eth-Sepolia agent runs its
  // full sense→decide→gate→act loop and lands a governed call against a REAL protocol
  // available on that chain. These are the real-protocol targets the owner grant
  // surface allows (router = Uniswap SwapRouter02, settlementToken = WETH/USDC,
  // vault = an ERC-4626 if present). All optional: unset ⇒ Eth Sepolia stays
  // destination-only (no promotion), never a partial/implicit grant.
  SEPOLIA_CAP_ROUTER_ADDR: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  SEPOLIA_CAP_VAULT_ADDR: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  SEPOLIA_CAP_SETTLEMENT_TOKEN_ADDR: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  /** SE-10: comma-separated allowlisted REAL protocol contracts on Ethereum Sepolia. */
  SEPOLIA_PROTOCOL_ALLOWLIST: z.string().optional(),
  /**
   * SE-10 (E-11): the GENERIC chain-table — onboard any remaining top EVM testnet
   * (Optimism Sepolia, Polygon Amoy, …) as PURE CONFIG, no code fork (fulfils the
   * SE-5 "adding a chain is config-only" promise end-to-end). A JSON array of
   * `{ chainId, name, rpcUrl, registryAddr, factoryV4Addr?, protocolAllowlist?,
   * bridgeAllowlist?, canonical? }`. `factoryV4Addr` defaults to the deterministic
   * CREATE2 factory (same address everywhere, SD-E9); accountVersion is always 4.
   * Fail-loud parse (L-03 posture) + testnet-only guard (registry) + default-deny
   * for any chain NOT listed (E-11). Unset ⇒ no extra chains.
   */
  EXTRA_CHAINS: z.string().optional(),
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

/**
 * SE-5 (E-5): the chain-config table. Replaces the single `ZERO_G_CHAIN_ID` with
 * an array the `ChainRegistry` resolves by `chainId`. Today it holds the one 0G
 * Galileo entry derived from the existing env — onboarding another testnet (SE-7
 * Base Sepolia, SE-9 Arbitrum, …) is a CONFIG-ONLY change: append an entry here,
 * no code fork (the registry + drills are chain-agnostic). 0G enforces a 2-gwei
 * gas floor (observed live, 2026-09); other chains carry their own.
 */
/**
 * SE-8: `bridgeAddr:destinationChainId` comma-list → the consumed bridge policy
 * (`bridgeAllowlist` + `bridgeDestinations`). Fail-loud (L-03 posture): a typo'd
 * bridge address or chain id fails STARTUP, never a silent drop that would turn a
 * legitimate governed bridge into a runtime refusal (or worse, mask the gate).
 */
function parseBridgeAllowlist(raw: string): {
  bridgeAllowlist: string[];
  bridgeDestinations: Record<string, number>;
} {
  const bridgeAllowlist: string[] = [];
  const bridgeDestinations: Record<string, number> = {};
  for (const entry of raw.split(',')) {
    const [addrRaw, destRaw, ...rest] = entry.trim().split(':');
    const addr = (addrRaw ?? '').trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(addr) || rest.length > 0) {
      throw new Error(`BRIDGE_ALLOWLIST entry is not "address:destChainId": "${entry.trim()}"`);
    }
    const dest = Number((destRaw ?? '').trim());
    if (!Number.isInteger(dest) || dest <= 0) {
      throw new Error(`BRIDGE_ALLOWLIST destination chain id invalid in: "${entry.trim()}"`);
    }
    bridgeAllowlist.push(addr);
    bridgeDestinations[addr] = dest;
  }
  return { bridgeAllowlist, bridgeDestinations };
}

/**
 * Fail-loud (L-03) comma-separated address list → lowercased addresses. A typo'd
 * entry FAILS startup rather than silently dropping a real-protocol address (which
 * would turn a legitimate governed call into an unexplained runtime refusal).
 */
function parseAddressList(raw: string, label: string): string[] {
  return raw.split(',').map((e) => {
    const a = e.trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(a)) throw new Error(`${label} entry is not an address: "${e.trim()}"`);
    return a;
  });
}

const extraChainSchema = z.object({
  chainId: z.number().int().positive(),
  name: z.string().min(1),
  rpcUrl: z.string().url(),
  registryAddr: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  factoryV4Addr: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  protocolAllowlist: z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/)).optional(),
  bridgeAllowlist: z.string().optional(), // "addr:destChainId" comma-list (same grammar as the per-chain vars)
  canonical: z
    .object({
      router: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
      vault: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
      settlementToken: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
    })
    .optional(),
  gasFloorWei: z.string().regex(/^\d{1,30}$/).optional(),
  // RH2 (two-factory): named secondary factories carrying a distinct wall
  // capability (e.g. `oracleBand`). Bounded (L-02) + address-shaped (L-03).
  capabilityFactories: z.record(z.string().regex(/^0x[0-9a-fA-F]{40}$/)).optional(),
});

/**
 * SE-10 (E-11): parse the GENERIC chain-table. Each entry becomes a `ChainConfig`
 * with NO per-chain code — the proof that "a new chain is config, not code". The V4
 * factory defaults to the deterministic CREATE2 address (same everywhere, SD-E9);
 * accountVersion is always 4. Fail-loud (L-03): a malformed blob FAILS startup.
 * The registry's `assertTestnetOnly` + duplicate-chain guard still apply downstream.
 */
export function parseExtraChains(raw: string, defaultFactoryV4?: string): ChainConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('EXTRA_CHAINS is not valid JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('EXTRA_CHAINS must be a JSON array of chain entries');
  // sec L-02 (SE-10 gate): bound the operator-controlled table so a fat-fingered
  // blob cannot spin up an unbounded number of chain clients at boot.
  if (parsed.length > 32) throw new Error(`EXTRA_CHAINS has too many entries (${parsed.length} > 32)`);
  return parsed.map((entryRaw, i) => {
    const r = extraChainSchema.safeParse(entryRaw);
    if (!r.success) {
      throw new Error(`EXTRA_CHAINS[${i}] invalid: ${r.error.issues.map((x) => x.path.join('.') || '(root)').join(', ')}`);
    }
    const e = r.data;
    const factoryV4Addr = e.factoryV4Addr ?? defaultFactoryV4;
    if (!factoryV4Addr) {
      throw new Error(`EXTRA_CHAINS[${i}] (${e.name}) has no factoryV4Addr and LEASH_FACTORY_V4_ADDR is unset`);
    }
    const bridge = e.bridgeAllowlist ? parseBridgeAllowlist(e.bridgeAllowlist) : undefined;
    return {
      chainId: e.chainId,
      name: e.name,
      rpcUrl: e.rpcUrl,
      factoryV4Addr: factoryV4Addr.toLowerCase(),
      registryAddr: e.registryAddr,
      accountVersion: 4,
      gasFloorWei: e.gasFloorWei ? BigInt(e.gasFloorWei) : 0n,
      ...(e.canonical
        ? {
            canonical: {
              ...(e.canonical.router ? { router: e.canonical.router.toLowerCase() } : {}),
              ...(e.canonical.vault ? { vault: e.canonical.vault.toLowerCase() } : {}),
              ...(e.canonical.settlementToken ? { settlementToken: e.canonical.settlementToken.toLowerCase() } : {}),
            },
          }
        : {}),
      ...(e.protocolAllowlist ? { protocolAllowlist: e.protocolAllowlist.map((a) => a.toLowerCase()) } : {}),
      ...(bridge ?? {}),
      ...(e.capabilityFactories
        ? (() => {
            const keys = Object.keys(e.capabilityFactories);
            // L-02: bound the operator-controlled capability map.
            if (keys.length > 8) throw new Error(`EXTRA_CHAINS[${i}] (${e.name}) has too many capabilityFactories (${keys.length} > 8)`);
            return {
              capabilityFactories: Object.fromEntries(
                Object.entries(e.capabilityFactories).map(([k, v]) => [k, v.toLowerCase()]),
              ),
            };
          })()
        : {}),
    } satisfies ChainConfig;
  });
}

export function buildChainConfigs(cfg: Config): ChainConfig[] {
  const chains: ChainConfig[] = [
    {
      chainId: cfg.ZERO_G_CHAIN_ID,
      name: '0G Galileo Testnet',
      rpcUrl: cfg.ZERO_G_RPC,
      factoryAddr: cfg.LEASH_FACTORY_ADDR,
      factoryV4Addr: cfg.LEASH_FACTORY_V4_ADDR,
      registryAddr: cfg.AGENT_REGISTRY_ADDR,
      accountVersion: 4, // SD-E7: governed calldata is the create default
      canonical: {
        router: cfg.CAP_ROUTER_ADDR,
        vault: cfg.CAP_VAULT_ADDR,
        settlementToken: cfg.CAP_SETTLEMENT_TOKEN_ADDR,
      },
      gasFloorWei: 2_000_000_000n, // 2 gwei — 0G node minimum
    },
  ];
  // SE-7: Base Sepolia (84532) — appended only when BOTH env vars are set
  // (default-deny otherwise: an unregistered chain cannot be targeted, E-11).
  if (cfg.BASE_SEPOLIA_RPC && cfg.AGENT_REGISTRY_BASE_ADDR) {
    chains.push({
      chainId: 84532,
      name: 'Base Sepolia',
      rpcUrl: cfg.BASE_SEPOLIA_RPC,
      // No legacy v2 factory on Base — a legacy create there fails loudly.
      factoryV4Addr: cfg.LEASH_FACTORY_V4_ADDR,
      registryAddr: cfg.AGENT_REGISTRY_BASE_ADDR,
      accountVersion: 4,
      canonical: {
        router: cfg.BASE_CAP_ROUTER_ADDR,
        vault: cfg.BASE_CAP_VAULT_ADDR,
        settlementToken: cfg.BASE_CAP_SETTLEMENT_TOKEN_ADDR,
      },
      gasFloorWei: 0n, // Base enforces no static floor; EIP-1559 estimation applies
      ...(cfg.BASE_PROTOCOL_ALLOWLIST
        ? {
            // sec L-03 (SE-7): a malformed entry FAILS startup — silently
            // dropping a typo'd real-protocol address would make a governed
            // call to the intended protocol refuse unexpectedly at runtime.
            protocolAllowlist: cfg.BASE_PROTOCOL_ALLOWLIST.split(',').map((raw) => {
              const a = raw.trim().toLowerCase();
              if (!/^0x[0-9a-f]{40}$/.test(a)) {
                throw new Error(`BASE_PROTOCOL_ALLOWLIST entry is not an address: "${raw.trim()}"`);
              }
              return a;
            }),
          }
        : {}),
      ...(cfg.BASE_BRIDGE_ALLOWLIST ? parseBridgeAllowlist(cfg.BASE_BRIDGE_ALLOWLIST) : {}),
    });
  }
  // SE-8: Ethereum Sepolia (11155111) — the OP-stack bridge DESTINATION chain.
  // Appended only when BOTH env vars are set (default-deny otherwise, E-11); the
  // pre-routing same-address verification resolves it to confirm the far-chain
  // account before any bridge call routes.
  if (cfg.ETHEREUM_SEPOLIA_RPC && cfg.AGENT_REGISTRY_SEPOLIA_ADDR) {
    chains.push({
      chainId: 11155111,
      name: 'Ethereum Sepolia',
      rpcUrl: cfg.ETHEREUM_SEPOLIA_RPC,
      factoryV4Addr: cfg.LEASH_FACTORY_V4_ADDR,
      registryAddr: cfg.AGENT_REGISTRY_SEPOLIA_ADDR,
      accountVersion: 4,
      gasFloorWei: 0n,
      // SE-10 (E-11): PROMOTION — when the real-protocol targets are configured, Eth
      // Sepolia becomes a FULL governed home chain (a home agent can be minted here
      // and granted real-protocol rules). Unset ⇒ it stays a bridge-destination-only
      // chain (SE-8 posture), never a partial grant.
      ...(cfg.SEPOLIA_CAP_ROUTER_ADDR || cfg.SEPOLIA_CAP_VAULT_ADDR || cfg.SEPOLIA_CAP_SETTLEMENT_TOKEN_ADDR
        ? {
            canonical: {
              ...(cfg.SEPOLIA_CAP_ROUTER_ADDR ? { router: cfg.SEPOLIA_CAP_ROUTER_ADDR } : {}),
              ...(cfg.SEPOLIA_CAP_VAULT_ADDR ? { vault: cfg.SEPOLIA_CAP_VAULT_ADDR } : {}),
              ...(cfg.SEPOLIA_CAP_SETTLEMENT_TOKEN_ADDR ? { settlementToken: cfg.SEPOLIA_CAP_SETTLEMENT_TOKEN_ADDR } : {}),
            },
          }
        : {}),
      ...(cfg.SEPOLIA_PROTOCOL_ALLOWLIST
        ? { protocolAllowlist: parseAddressList(cfg.SEPOLIA_PROTOCOL_ALLOWLIST, 'SEPOLIA_PROTOCOL_ALLOWLIST') }
        : {}),
    });
  }
  // SE-9 (E-10): Arbitrum Sepolia (421614) — the DIVERGENT bridge family. Appended
  // only when BOTH env vars are set (default-deny otherwise, E-11). Proves governance
  // is chain-agnostic: a 2nd bridge family (GatewayRouter/ArbSys) onboards as CONFIG
  // (this entry + the bridge allowlist + a token pair), not new code.
  if (cfg.ARBITRUM_SEPOLIA_RPC && cfg.AGENT_REGISTRY_ARBITRUM_ADDR) {
    chains.push({
      chainId: 421614,
      name: 'Arbitrum Sepolia',
      rpcUrl: cfg.ARBITRUM_SEPOLIA_RPC,
      factoryV4Addr: cfg.LEASH_FACTORY_V4_ADDR,
      registryAddr: cfg.AGENT_REGISTRY_ARBITRUM_ADDR,
      accountVersion: 4,
      canonical: {
        settlementToken: cfg.ARB_CAP_BRIDGE_TOKEN_L2,
      },
      gasFloorWei: 0n, // Arbitrum uses EIP-1559 estimation; no static floor
      ...(cfg.ARB_PROTOCOL_ALLOWLIST
        ? {
            protocolAllowlist: cfg.ARB_PROTOCOL_ALLOWLIST.split(',').map((raw) => {
              const a = raw.trim().toLowerCase();
              if (!/^0x[0-9a-f]{40}$/.test(a)) {
                throw new Error(`ARB_PROTOCOL_ALLOWLIST entry is not an address: "${raw.trim()}"`);
              }
              return a;
            }),
          }
        : {}),
      ...(cfg.ARB_BRIDGE_ALLOWLIST ? parseBridgeAllowlist(cfg.ARB_BRIDGE_ALLOWLIST) : {}),
    });
  }
  // SE-10 (E-11): the GENERIC chain-table — remaining top EVM testnets onboard here
  // as PURE CONFIG (no per-chain code block). This is the end-to-end proof of SE-5's
  // "adding a chain is config-only" promise: any JSON entry below becomes a full
  // governed chain with the same wall + registry + default-deny guarantees.
  if (cfg.EXTRA_CHAINS) {
    chains.push(...parseExtraChains(cfg.EXTRA_CHAINS, cfg.LEASH_FACTORY_V4_ADDR));
  }
  return chains;
}
