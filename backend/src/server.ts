import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import type { Pool } from 'pg';
import type { ComputeQueue } from './gateway/compute-queue.js';
import type { TargetCatalog } from './governed-call/index.js';
import { gatewayRouter } from './gateway/routes.js';
import type { McpToolProvider } from './gateway/mcp/provider.js';
import { ownerRouter, type OwnerChainRegistry } from './api/owner-routes.js';
import type { PrivyVerifier } from './api/privy.js';
import type { SseHub } from './sse/hub.js';
import type { ApprovalBroker } from './approvals/broker.js';
import type { DelegationCoordinator } from './coordination/coordinator.js';
import type { AlertService } from './alerts/service.js';
import { telegramWebhookRouter } from './telegram/routes.js';
import type { TelegramBot } from './telegram/bot.js';
import type { DigestService } from './digest/service.js';
import type { Keyring } from './crypto/keycrypt.js';
import type { PolicyView } from './types.js';

/**
 * On-chain operations. Two signing lanes (C-1): deployer/ops key for creates,
 * registry, funding; dedicated guardian key for revoke — independent nonce
 * spaces so a revoke never queues behind a create burst.
 */
/**
 * SE-6: the serializable canonical v4 construction tuple (bigints as strings) —
 * the exact args baked into the account's CREATE2 initcode at mint time.
 */
export interface AccountCreateTuple {
  ownerAddr: string;
  guardianAddr: string;
  sessionKeyAddr: string;
  policy: { perTransferCap: string; windowCap: string; windowSeconds: number; expiresAt: number };
  allowlist: string[];
  timelockDelay: number;
  settlementToken: string;
  tokenPolicy: { perTransferCapToken: string; windowCapToken: string };
}

export interface ChainOps {
  deployAndRegister(input: {
    ownerAddr: string;
    sessionKeyAddr: string;
    auditPubKey: string;
    name: string;
    /**
     * SE-1 (Stage E, SD-E7): which account bytecode to mint — 4 = governed-
     * calldata V4 (the product-standard account; selects `createAccountV4` on
     * the V4 factory), 2 = legacy v2/v3 (selects `createAccount` on the legacy
     * factory). Arg-identical wire; only the factory + fn/event name differ.
     * Stage F′ (FP-4 P1): 5 = governed-signing V5 — minted through the generic
     * `Create2Deployer` with backend-assembled initcode (no typed factory).
     */
    accountVersion: 2 | 4 | 5 | 6;
    policy: { perTransferCap: bigint; windowCap: bigint; windowSeconds: number; expiresAt: number };
    allowlist: string[];
    timelockDelay: number;
    /**
     * Phase-4 optional settlement-token config (F1/F3). Omitted / zero address
     * ⇒ a native-only account (every legacy shape + provider/evaluator). When
     * set, the account is token-capable with these immutable per-token caps.
     */
    settlementToken?: string;
    tokenPolicy?: { perTransferCapToken: bigint; windowCapToken: bigint };
    /**
     * SE-6: the per-agent CREATE2 salt (0x-prefixed bytes32) for a deterministic
     * V4 mint. Omitted ⇒ the ops layer generates a fresh random salt (a
     * first-chain create); supplied ⇒ reuse (onboarding the SAME agent onto
     * another chain at the SAME address). Ignored for legacy v2 mints.
     */
    accountSalt?: string;
  }): Promise<{
    accountAddr: string;
    chainAgentId: bigint;
    createTx: string;
    registerTx: string;
    guardianAddr: string;
    accountVersion: 2 | 4 | 5 | 6;
    accountSalt: string | null;
    /**
     * SE-6: the EXACT canonical construction tuple the v4/v5 mint used
     * (serializable; null for legacy mints) — persisted so a later chain onboard
     * replays it verbatim (the tuple is baked into the CREATE2 initcode).
     */
    accountCreateTuple: AccountCreateTuple | null;
    /**
     * Stage F′ (FP-4 P1, RULING-A): keccak256 of the EXACT V5 initcode the deploy
     * ran — persisted at mint so `assertSameAddress` compares THAT, not a re-derived
     * mutable tuple. Null for V4/legacy mints (their predict is factory-side).
     */
    initCodeHash: string | null;
    /** SE-6 (M-02): a pre-existing deterministic deploy was adopted (no mint tx). */
    adopted: boolean;
  }>;
  /**
   * `accountGuardianAddr` = the guardian recorded for this account at create
   * (null = legacy ops-key guardian, S7). Rejects (throws) on a reverted tx —
   * callers must not mark the agent revoked on failure (C-2).
   */
  revoke(accountAddr: string, accountGuardianAddr?: string | null): Promise<{ txHash: string }>;
  fundSessionKey(addr: string, amountWei: bigint): Promise<{ txHash: string }>;
  /** AQ-FND Lane-B: `assetCandidates` = V6 asset-map tokens to read (the map is not enumerable). */
  getPolicyView(accountAddr: string, allowlistCandidates: string[], assetCandidates?: string[]): Promise<PolicyView>;
  getBalance(addr: string): Promise<bigint>;
  /** Live on-chain guardian (lowercased) — M-03 stale-guardian resync. */
  getGuardian(accountAddr: string): Promise<string>;
  /**
   * RH2 (V5 migration): true when this chain has all three V5 singletons wired
   * (deployer/signingHelper/decodeHelper) so an accountVersion:5 mint can land.
   * Lets the create route fail-closed with a typed 409 instead of a 500 on a
   * half-wired chain. Optional — faked ops in tests may omit it.
   */
  supportsV5?(): boolean;
  /** AQ-FND Lane-B: all five V6 singletons wired ⇒ a v6 mint can land (typed 409 otherwise). */
  supportsV6?(): boolean;
}

export interface RuntimeManager {
  start(agentId: string): Promise<void>;
  stop(agentId: string): Promise<void>;
  isRunning(agentId: string): boolean;
  haltForRevoke(agentId: string): Promise<void>;
  /**
   * Delivery-latency optimization ONLY (spec §3b): wake the agent's loop so an
   * activated delegation is picked up now instead of on the next poll. The
   * poll remains the correctness path — a missed/no-op nudge (agent stopped,
   * cycle in flight) loses nothing.
   */
  nudge(agentId: string): void;
  /**
   * SE-2 (SD-E2): after the owner approves-once (and signs `authorizeOnce`
   * client-side), auto-retry the originally-refused call to consume the on-chain
   * one-shot exactly once. Fire-and-forget — the on-chain submit never blocks the
   * HTTP response; freshness re-check + fail-safe live in the runtime path.
   */
  consumeApprovedOneShot(agentId: string, requestId: string): Promise<void>;
  /**
   * FP-3: after the owner approves a sensitive L2 signing request, arm the held intent on-chain via
   * the agent's session key (the signing analogue of `consumeApprovedOneShot`). Fire-and-forget.
   */
  armApprovedSigning?(agentId: string, requestId: string): Promise<void>;
}

export interface Settings {
  keyring: Keyring;
  approvalTimeoutMs: number;
  sessionGasDustWei: bigint;
  defaultTimelockDelay: number;
  /** 0G Storage indexer base URL — used to build public ciphertext download URLs. */
  storageIndexerUrl: string;
  /** C-1 limits (07 S6): quota counts ALL rows incl. revoked. */
  createQuotaPerOwner: number;
  createRatePerHour: number;
  /** P3C-1: in-flight create reservations count against quota/rate until released or TTL-dead. */
  reservationTtlMs: number;
  /** P3C-5: fleet-list balance reads are cached per account for this long (authed RPC-amplification bound). */
  balanceCacheTtlMs: number;
  allowlistMax: number;
  rulesMax: number;
  /** Phase-5 (D-B1): the 0G-catalog model spec-elevation runs on (LEASH's key). */
  elevationModel: string;
  /** Delegation channel bounds (spec §3b) — see config.ts for rationale. */
  delegationTtlMs: number;
  delegationRatePerLinkPerHour: number;
  delegationMaxPendingPerLink: number;
  delegationPayloadMaxBytes: number;
  /** Phase 5.6 chaining bounds (spec §5) — depth cap + per-hop eligible-set cap. */
  chainMaxDepth: number;
  chainMaxEligiblePerHop: number;
  /** Stage D (spec §5): per-network target catalog (mock targets on 0G, decision (c)). */
  capabilityCatalog: TargetCatalog;
  /** Stage D: how long a JIT (L2) capability card stays actionable (ms). */
  jitTtlMs: number;
  /** SE-5 (Stage E): the chain new agents are created on (the (chainId, account) anchor). */
  defaultChainId: number;
  /**
   * SF-2: LEASH's own public base URL (e.g. https://api.leash.ink).
   * Used to build the gateway + MCP endpoints an external bound agent swaps its
   * base_url to. Empty string in dev ⇒ the bind response returns path-only hints.
   */
  publicBaseUrl: string;
}

export interface AppDeps {
  pool: Pool;
  queue: ComputeQueue;
  hub: SseHub;
  broker: ApprovalBroker;
  privy: PrivyVerifier;
  chain: ChainOps;
  runtime: RuntimeManager;
  coordinator: DelegationCoordinator;
  alerts: AlertService;
  digest: DigestService;
  /** Present only when TELEGRAM_BOT_TOKEN is configured (S9). */
  telegram?: { bot: TelegramBot; webhookSecret: string } | undefined;
  settings: Settings;
  /** SE-7: multichain registry surface for the owner chain routes (optional). */
  chainRegistry?: OwnerChainRegistry | undefined;
  /**
   * SF-1 (BR-F2): the MCP tool-provider for the gateway `/mcp` transport.
   * Omitted ⇒ `denyAllProvider` (default-deny; SF-3 injects the governed one).
   */
  mcpProvider?: McpToolProvider | undefined;
  /** SCOPE-RH2-2: fired after an audit-key rotation so batchers clear quarantine. */
  onAuditKeyRotated?: ((stream: 'trace' | 'owner', key: string) => void) | undefined;
}

interface Surfaces {
  gateway: boolean;
  owner: boolean;
}

/**
 * Public app (M-01): owner API + SSE + healthz ONLY. In production this is
 * the sole surface bound to HOST:PORT — the gateway never leaves loopback.
 */
export function createOwnerApp(deps: AppDeps): Express {
  return buildApp(deps, { gateway: false, owner: true });
}

/** Gateway app (M-01): /v1/chat/completions ONLY — bound to 127.0.0.1 in prod. */
export function createGatewayApp(deps: AppDeps): Express {
  return buildApp(deps, { gateway: true, owner: false });
}

/** Both surfaces on one app — in-process convenience for tests ONLY. */
export function createApp(deps: AppDeps): Express {
  return buildApp(deps, { gateway: true, owner: true });
}

function buildApp(deps: AppDeps, surfaces: Surfaces): Express {
  const app = express();
  app.disable('x-powered-by');

  if (surfaces.owner) {
    // CORS for the owner FE (bearer-token auth, no cookies — wildcard is safe;
    // per-route authz still applies). The gateway's only Phase-1 client is the
    // co-located runtime, which never preflights — no CORS on that surface.
    app.use((req: Request, res: Response, next: NextFunction) => {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-headers', 'authorization, content-type');
      // PATCH: the rules editor (PATCH /api/agents/:id/rules) preflights from the FE.
      res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, OPTIONS');
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
      next();
    });

    app.get('/healthz', (_req, res) => {
      res.json({ ok: true }); // liveness only, no detail
    });
  }

  if (surfaces.gateway) {
    app.use(
      gatewayRouter({
        pool: deps.pool,
        queue: deps.queue,
        hub: deps.hub,
        broker: deps.broker,
        alerts: deps.alerts,
        approvalTimeoutMs: deps.settings.approvalTimeoutMs,
        mcpProvider: deps.mcpProvider,
      }),
    );
  }
  if (surfaces.owner) {
    // Webhook BEFORE the owner router: /api/telegram/webhook is secret-token
    // authed, NOT Privy-authed — mounting order keeps the owner-wide Privy
    // middleware off this one path (S9).
    if (deps.telegram) {
      app.use(telegramWebhookRouter(deps.telegram.bot, deps.telegram.webhookSecret));
    }
    app.use(ownerRouter({ ...deps, telegram: deps.telegram?.bot }));
  }

  // 404 for everything else (exact routing — no fuzzy path matching)
  app.use((_req, res) => {
    res.status(404).json({ error: { message: 'not found' } });
  });

  // generic errors to clients; detail stays server-side (M-01).
  // _req/_next: express detects error handlers by arity — all 4 params required.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (isBodyTooLarge(err)) {
      res.status(413).json({ error: { message: 'payload too large' } });
      return;
    }
    if (isBadJson(err)) {
      res.status(400).json({ error: { message: 'invalid JSON body' } });
      return;
    }
    console.error('unhandled request error', err);
    if (!res.headersSent) res.status(500).json({ error: { message: 'internal error' } });
  });

  return app;
}

function isBodyTooLarge(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { type?: string }).type === 'entity.too.large';
}

function isBadJson(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { type?: string }).type === 'entity.parse.failed';
}
