import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import type { Pool } from 'pg';
import type { ComputeQueue } from './gateway/compute-queue.js';
import { gatewayRouter } from './gateway/routes.js';
import { ownerRouter } from './api/owner-routes.js';
import type { PrivyVerifier } from './api/privy.js';
import type { SseHub } from './sse/hub.js';
import type { ApprovalBroker } from './approvals/broker.js';
import type { DelegationCoordinator } from './coordination/coordinator.js';
import type { PolicyView } from './types.js';

/**
 * On-chain operations. Two signing lanes (C-1): deployer/ops key for creates,
 * registry, funding; dedicated guardian key for revoke — independent nonce
 * spaces so a revoke never queues behind a create burst.
 */
export interface ChainOps {
  deployAndRegister(input: {
    ownerAddr: string;
    sessionKeyAddr: string;
    auditPubKey: string;
    name: string;
    policy: { perTransferCap: bigint; windowCap: bigint; windowSeconds: number; expiresAt: number };
    allowlist: string[];
    timelockDelay: number;
  }): Promise<{ accountAddr: string; chainAgentId: bigint; createTx: string; registerTx: string; guardianAddr: string }>;
  /**
   * `accountGuardianAddr` = the guardian recorded for this account at create
   * (null = legacy ops-key guardian, S7). Rejects (throws) on a reverted tx —
   * callers must not mark the agent revoked on failure (C-2).
   */
  revoke(accountAddr: string, accountGuardianAddr?: string | null): Promise<{ txHash: string }>;
  fundSessionKey(addr: string, amountWei: bigint): Promise<{ txHash: string }>;
  getPolicyView(accountAddr: string, allowlistCandidates: string[]): Promise<PolicyView>;
  getBalance(addr: string): Promise<bigint>;
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
}

export interface Settings {
  keyEncryptionSecret: string;
  approvalTimeoutMs: number;
  sessionGasDustWei: bigint;
  defaultTimelockDelay: number;
  /** 0G Storage indexer base URL — used to build public ciphertext download URLs. */
  storageIndexerUrl: string;
  /** C-1 limits (07 S6): quota counts ALL rows incl. revoked. */
  createQuotaPerOwner: number;
  createRatePerHour: number;
  allowlistMax: number;
  rulesMax: number;
  /** Delegation channel bounds (spec §3b) — see config.ts for rationale. */
  delegationTtlMs: number;
  delegationRatePerLinkPerHour: number;
  delegationMaxPendingPerLink: number;
  delegationPayloadMaxBytes: number;
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
  settings: Settings;
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
        approvalTimeoutMs: deps.settings.approvalTimeoutMs,
      }),
    );
  }
  if (surfaces.owner) {
    app.use(ownerRouter(deps));
  }

  // 404 for everything else (exact routing — no fuzzy path matching)
  app.use((_req, res) => {
    res.status(404).json({ error: { message: 'not found' } });
  });

  // generic errors to clients; detail stays server-side (M-01)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- express detects error handlers by arity: all 4 params required
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
