import 'dotenv/config';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { loadConfig, buildChainConfigs, resolveKeyring } from './config.js';
import { ChainRegistry } from './chain/registry.js';
import { createPool, createDirectPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { createOwnerApp, createGatewayApp } from './server.js';
import { ComputeQueue } from './gateway/compute-queue.js';
import { createGovernedMcpProvider, createDbGrantLoader } from './gateway/mcp/governed-provider.js';
import { createHttpMcpEgressClient, parseEgressConfigFromEnv } from './gateway/mcp/egress.js';
import { SseHub } from './sse/hub.js';
import { ApprovalBroker } from './approvals/broker.js';
import { createPrivyVerifier } from './api/privy.js';
import { zeroGChain } from './chain/ops.js';
import { RevokeWatcher } from './chain/revoke-watcher.js';
import { viemRevokedLogSource } from './chain/log-source.js';
import { AuditBatcher, StreamBatcher, ownerStreamSource } from './audit/batcher.js';
import { ZeroGStorage } from './audit/storage.js';
import { LeashRuntimeManager } from './runtime/manager.js';
import { RuntimeLease } from './runtime/lease.js';
import { backfillLegacyGuardian } from './store/agents.js';
import { sweepStaleReservations } from './store/reservations.js';
import { pruneAllStaleDraftDirections } from './store/directions.js';
import { sweepPendingSettlements } from './jobs/settlement-sweep.js';
import { sweepRailRecovery } from './runtime/rail-recovery.js';
import { createCctpRailDriver, createHttpIris } from './runtime/cctp-driver.js';
import { pgRevokeCursorStore } from './store/revoke-cursor.js';
import { runtimeRoleCanBypassAudit } from './db/audit-role.js';
import { sweepOrphanedApprovals } from './approvals/sweep.js';
import { DelegationCoordinator, runBootSweep } from './coordination/coordinator.js';
import { onHopSettled } from './coordination/chain.js';
import type { Json } from './crypto/canonical.js';
import { AlertService } from './alerts/service.js';
import { TelegramBot } from './telegram/bot.js';
import { FetchTelegramApi } from './telegram/api.js';
import { DigestService } from './digest/service.js';
import { getAgentById } from './store/agents.js';
import { decryptSecret } from './crypto/keycrypt.js';

/** Composition root: wire every module, migrate, listen, run the loops. */
async function main(): Promise<void> {
  // Boot phase timing — on a cold start Render kills the instance if no port is
  // bound within its startup window, so we log elapsed-ms per phase to make a
  // slow phase visible in the deploy logs (and we bind the port before the
  // non-essential background init below).
  const bootStart = Date.now();
  const phase = (label: string): void =>
    console.error(`[boot +${((Date.now() - bootStart) / 1000).toFixed(1)}s] ${label}`);

  const cfg = loadConfig();
  // SCOPE-I-7: resolve the at-rest encryption keyring (fail-loud at boot).
  const keyring = resolveKeyring(cfg);
  phase('config loaded');
  // Sanity: the configured ops address must be the ops key's address — a
  // mismatch means the wrong key is deployed (fail fast, before any wiring).
  const opsAddr = privateKeyToAccount(cfg.OPS_PRIVATE_KEY as `0x${string}`).address;
  if (opsAddr.toLowerCase() !== cfg.OPS_ADDRESS.toLowerCase()) {
    throw new Error('OPS_ADDRESS does not match the address derived from OPS_PRIVATE_KEY');
  }
  // C-1: same fail-fast for the guardian lane key.
  const guardianAddr = privateKeyToAccount(cfg.GUARDIAN_PRIVATE_KEY as `0x${string}`).address;
  if (guardianAddr.toLowerCase() !== cfg.GUARDIAN_ADDRESS.toLowerCase()) {
    throw new Error('GUARDIAN_ADDRESS does not match the address derived from GUARDIAN_PRIVATE_KEY');
  }
  if (guardianAddr.toLowerCase() === opsAddr.toLowerCase()) {
    throw new Error('guardian key must be distinct from the ops key (independent nonce lanes, C-1)');
  }
  const pool = createPool(cfg.DATABASE_URL);
  // C-6: DDL (migrations + checkpointer setup) runs on the ADMIN connection
  // when the app itself is the restricted runtime role.
  const migratePool = cfg.MIGRATE_DATABASE_URL ? createPool(cfg.MIGRATE_DATABASE_URL) : pool;
  const applied = await migrate(migratePool);
  if (applied.length > 0) console.error(`migrations applied: ${applied.join(', ')}`);
  phase(`migrations done (${applied.length} applied)`);
  // INFRA-1: surface a vacuous append-only-audit posture. If the runtime role can
  // TRUNCATE trace_records it is the owner/admin (can also DISABLE the triggers),
  // so the tamper-evidence guarantee is NOT enforced against this process. Prod
  // must run as the restricted role (DATABASE_URL=restricted, MIGRATE=admin).
  if (await runtimeRoleCanBypassAudit(pool)) {
    const msg =
      'WARNING [INFRA-1]: runtime DB role can TRUNCATE trace_records — the append-only audit guarantee is NOT enforced against this process. Production must connect as the restricted runtime role; see scripts/provision-runtime-role.mjs.';
    // Strict mode (prod): fail fast rather than run with a vacuous audit trail.
    if (cfg.REQUIRE_RESTRICTED_AUDIT_ROLE === 'true') throw new Error(msg);
    console.error(msg);
  }
  // S7: legacy Phase-1 rows get their real (ops-key) guardian recorded so the
  // revoke lane selection is explicit, not inferred from NULL.
  const backfilled = await backfillLegacyGuardian(pool, opsAddr);
  if (backfilled > 0) console.error(`legacy guardian_addr backfilled on ${backfilled} agent(s)`);
  // C-6 startup sweep: orphaned pending approvals → expired, chain-visible.
  const swept = await sweepOrphanedApprovals(pool);
  if (swept.length > 0) console.error(`swept ${swept.length} orphaned pending approval(s)`);
  // P3C-1 boot sweep: reservations orphaned by a crash mid-create. Counting
  // already ignores TTL-dead rows; this keeps the table honest.
  const staleReservations = await sweepStaleReservations(pool, cfg.RESERVATION_TTL_MS);
  if (staleReservations > 0) console.error(`released ${staleReservations} stale create reservation(s)`);
  // SCOPE-I-10: the periodic reservation + directions sweep timers are
  // lease-gated, so they are constructed AFTER the runtime lease (below) and
  // short-circuit on a non-holder. Only the one-time boot sweep runs here.

  const checkpointer = new PostgresSaver(pool, undefined, { schema: 'public' });
  if (migratePool === pool) {
    await checkpointer.setup();
  } else {
    // setup() is DDL — run it on the admin pool, then release it.
    await new PostgresSaver(migratePool, undefined, { schema: 'public' }).setup();
    await migratePool.end();
  }
  phase('checkpointer setup done');

  const hub = new SseHub({
    maxGlobal: cfg.SSE_MAX_GLOBAL,
    maxPerOwner: cfg.SSE_MAX_PER_OWNER,
    idleTimeoutMs: cfg.SSE_IDLE_TIMEOUT_MS,
  });
  // S8: owner aggregate fan-out — agent→owner resolved from the DB, cached.
  hub.setOwnerLookup(async (agentId) => (await getAgentById(pool, agentId))?.ownerAddr ?? null);
  const broker = new ApprovalBroker();
  // Phase-3 alert engine — constructed BEFORE the boot sweep so boot-swept
  // delegations surface in the inbox too.
  const alerts = new AlertService({
    pool,
    hub,
    settings: { alertRatePerOwnerPerHour: cfg.ALERT_RATE_PER_OWNER_PER_HOUR },
  });
  // C-6 startup sweep, coordination half (expiry point C): orphaned/stale
  // delegations → expired, chain-visibly, before any loop starts.
  const sweptDelegations = await runBootSweep(pool, hub, alerts);
  if (sweptDelegations.length > 0) console.error(`swept ${sweptDelegations.length} orphaned delegation(s)`);
  phase('boot sweeps done');
  const queue = new ComputeQueue({ baseUrl: cfg.COMPUTE_BASE_URL, apiKey: cfg.ZERO_G_COMPUTE_API_KEY });
  // SE-5 (E-5): the multichain backbone — one registry resolves ops/session clients
  // per chainId (default-deny for unregistered chains). The default chain drives the
  // existing single-chain runtime; onboarding another testnet is a config-only entry
  // in buildChainConfigs (no code fork here). Per-chain runtime threading lands with
  // the first real second chain (SE-7).
  const chainConfigs = buildChainConfigs(cfg);
  const chainRegistry = new ChainRegistry(chainConfigs, {
    opsPrivateKey: cfg.OPS_PRIVATE_KEY,
    guardianPrivateKey: cfg.GUARDIAN_PRIVATE_KEY,
  });
  // AQ-FND S1: every session-key write is recorded in the intent ledger BEFORE it is broadcast.
  // (the lane re-signs a stuck tx with the agent's own session key, and asks a human when it must not guess)
  chainRegistry.useIntentLedger(pool, {
    getSessionKey: async (agentId) => {
      const a = await getAgentById(pool, agentId);
      return a?.sessionKeyEnc ? decryptSecret(a.sessionKeyEnc, keyring) : null;
    },
    onNeedsReview: async (info) => {
      const a = await getAgentById(pool, info.agentId);
      if (!a) return;
      await alerts.emit(a.ownerAddr, {
        agentId: info.agentId,
        class: 'info',
        kind: 'runtime_error',
        summary: `${a.name} stopped sending: one of its transactions could not be resolved automatically (${info.reason}). LEASH will not send again from this agent until it is reviewed, so nothing can be paid twice.`,
        dedupKey: `intent_review:${info.intentId}`,
      });
    },
  });
  const defaultChainId = cfg.ZERO_G_CHAIN_ID;
  const chain = chainRegistry.getChainOps(defaultChainId);
  phase(`chain registry built (${chainConfigs.length} chains: ${chainConfigs.map((c) => c.chainId).join(',')})`);

  // 0G Storage Log Layer wrapper — the audit batcher's sink AND the Phase-4
  // job graph's deliverable/PoA sink (built here so the runtime can thread it).
  const uploader = new ZeroGStorage({
    indexerUrl: cfg.ZERO_G_STORAGE_INDEXER,
    rpcUrl: cfg.ZERO_G_RPC,
    opsPrivateKey: cfg.OPS_PRIVATE_KEY,
  });

  // F-6: DB-level runtime lease — two backends sharing one DB (branch deploy +
  // stray local boot, incident 2026-10-04) must never both loop agents. Only
  // the holder starts loops/watchers; losing the lease connection exits the
  // process (fail-safe: the lock died with it, another instance may now hold).
  // F-16: the lease MUST hold its advisory lock on a DIRECT (unpooled) Neon
  // connection. Through the pgbouncer pooler the session lock detaches from the
  // backend and shows "held" by a phantom ::1 conn while no process actually
  // loops — the lease could never reliably acquire. A tiny direct pool fixes it.
  const leasePool = createDirectPool(cfg.DATABASE_URL);
  const lease = new RuntimeLease(leasePool, (err) => {
    console.error('runtime lease connection lost — exiting so the supervisor restarts into the retry path', err);
    process.exit(1);
  });

  // SCOPE-I-10: periodic sweepers run ONLY on the lease holder (mirroring
  // oneShotSweepTimer below) — a second instance (overlapping deploy / stray
  // boot) must NOT double-run them. The one-time boot sweeps already ran above.
  const reservationSweepTimer = setInterval(() => {
    if (!lease.held()) return;
    void sweepStaleReservations(pool, cfg.RESERVATION_TTL_MS).catch((err: unknown) =>
      console.error('reservation sweep tick failed', err),
    );
  }, cfg.RESERVATION_TTL_MS);
  reservationSweepTimer.unref();

  // C2 (Phase 5.6): periodic prune of abandoned draft directions (moved off the
  // /direct hot path). 1h cadence, drops never-confirmed drafts older than 24h.
  const DIRECTIONS_DRAFT_TTL_S = 24 * 3600;
  const directionsSweepTimer = setInterval(() => {
    if (!lease.held()) return;
    void pruneAllStaleDraftDirections(pool, DIRECTIONS_DRAFT_TTL_S).catch((err: unknown) =>
      console.error('directions draft sweep tick failed', err),
    );
  }, 3600_000);
  directionsSweepTimer.unref();

  const runtime = new LeashRuntimeManager({
    pool,
    hub,
    broker,
    alerts,
    uploader,
    lease,
    chain: chainRegistry.getSessionChain(defaultChainId),
    // SE-7 (carry #2): per-chain runtime client resolution — a one-shot on a
    // non-home chain submits through THAT chain's client (default-deny beyond
    // the registry).
    resolveChain: (chainId: number) => chainRegistry.getSessionChain(chainId),
    // SE-8: the bridge lane (bridge allowlist enforcement + the assertSameAddress
    // pre-routing gate) resolves through the full registry.
    chainRegistry,
    checkpointer,
    settings: {
      keyring,
      approvalTimeoutMs: cfg.APPROVAL_TIMEOUT_MS,
      gatewayUrl: `http://127.0.0.1:${cfg.GATEWAY_PORT}`, // the runtime is the gateway's only client
      intervalMs: cfg.RUNTIME_INTERVAL_MS,
      failureBudget: cfg.AGENT_FAILURE_BUDGET,
      cctpFillEnabled: Boolean(cfg.CCTP_MESSAGE_TRANSMITTER_ADDR),
      defaultModel: cfg.RUNTIME_DEFAULT_MODEL,
      jobProviderModel: cfg.JOB_PROVIDER_MODEL,
      jobEvaluatorModel: cfg.JOB_EVALUATOR_MODEL,
      chainConfig: { maxDepth: cfg.CHAIN_MAX_DEPTH, maxEligiblePerHop: cfg.CHAIN_MAX_ELIGIBLE_PER_HOP },
      jitTtlMs: cfg.JIT_TTL_MS,
      // AQ-FND M-3: global session-key gas dust default — the gas ladder's rung-2/4 refuel
      // size when a chain does not override sessionGasDustWei.
      globalDustWei: BigInt(cfg.SESSION_GAS_DUST_WEI),
    },
  });

  // L-01 (SE-5.0): crash-durability for the fire-and-forget one-shot retry.
  // consumeApprovedOneShot is an in-memory trigger; a restart mid-retry would
  // strand an owner-authorized approve-once. The boot re-drive is deferred to
  // AFTER the port binds (startAfterListen) so a slow chain round-trip here
  // never delays the listener past Render's cold-start deadline; the periodic
  // timer (cadence = the one-shot TTL) re-drives resumable one-shots regardless.
  const oneShotSweepTimer = setInterval(() => {
    if (!lease.held()) return; // F-6: chain re-drives are the holder's job
    void runtime.sweepResumableOneShots().catch((err: unknown) =>
      console.error('one-shot consume sweep tick failed', err),
    );
  }, cfg.JIT_TTL_MS);
  oneShotSweepTimer.unref();

  // The settlement reconciliation sweep. A job fee is BROADCAST and its hash
  // persisted before the receipt wait, so an unreadable receipt leaves the job
  // in 'settling' instead of lying that it failed — this tick is what resolves
  // it against the chain (and appends the jobFee trace the owner digest reads).
  // Lease-held like the sweepers above: two instances must not both promote the
  // same row. 60s because an unreported paid settlement is the thing being
  // fixed; the per-row cost is one receipt read.
  const settlementSweepTimer = setInterval(() => {
    if (!lease.held()) return;
    void sweepPendingSettlements({
      pool,
      chain: chainRegistry.getSessionChain(defaultChainId),
      hub,
    }).catch((err: unknown) => console.error('settlement sweep tick failed', err));
  }, 60_000);
  settlementSweepTimer.unref();
  // AQ-FND S1: reconcile open transaction intents (resend the SAME bytes, never rebuild) — lease-gated.
  const intentReconcileTimer = setInterval(() => {
    if (!lease.held()) return;
    void chainRegistry.reconcileAllIntents().catch((err: unknown) => console.error('intent reconcile tick failed', err));
  }, 30_000);
  intentReconcileTimer.unref();

  // AQ-FND inc-3b: CCTP rail recovery. Advances open rail_transfers (confirm burn -> Circle
  // attestation -> ops-key receiveMessage on the destination -> filled). Lease-held; only armed
  // when a MessageTransmitter is configured. Idle until a bridge executor opens rows.
  const cctpTransmitter = cfg.CCTP_MESSAGE_TRANSMITTER_ADDR as `0x${string}` | undefined;
  const railSweepTimer = cctpTransmitter
    ? setInterval(() => {
        if (!lease.held()) return;
        const driver = createCctpRailDriver({
          iris: createHttpIris(cfg.CCTP_IRIS_URL),
          chains: {
            getTxStatus: (chainId, tx) => chainRegistry.getChainOps(chainId).getTxStatus(tx),
            sendOpsCall: (chainId, to, data) => chainRegistry.getChainOps(chainId).sendOpsCall(to, data),
          },
          messageTransmitter: () => cctpTransmitter,
        });
        void sweepRailRecovery({ pool, driver }).catch((err: unknown) => console.error('rail sweep tick failed', err));
      }, 30_000)
    : null;
  railSweepTimer?.unref();

  // Coordination layer (spec §3b): links/delegations lifecycle + channel
  // throttles + expiry sweeper. The nudge is delivery-latency only.
  const chainConfig = { maxDepth: cfg.CHAIN_MAX_DEPTH, maxEligiblePerHop: cfg.CHAIN_MAX_ELIGIBLE_PER_HOP };
  const coordinator = new DelegationCoordinator({
    pool,
    hub,
    runtime,
    alerts,
    settings: {
      delegationTtlMs: cfg.DELEGATION_TTL_MS,
      delegationRatePerLinkPerHour: cfg.DELEGATION_RATE_PER_LINK_PER_HOUR,
      delegationMaxPendingPerLink: cfg.DELEGATION_MAX_PENDING_PER_LINK,
      delegationPayloadMaxBytes: cfg.DELEGATION_PAYLOAD_MAX_BYTES,
    },
    // Phase 5.6 (generality-guard-clean): advance/terminate a chain when its
    // in-flight hop settles. onHopSettled is idempotent + a no-op for non-chain
    // delegations. The closure resolves `coordinator` lazily (fires at runtime).
    onDelegationTerminal: async (d) => {
      const output = ((d.result as { output?: unknown } | undefined)?.output ?? d.result ?? null) as Json;
      // W2: pass the chainId/hopIndex from the OPAQUE payload as a reconciliation
      // hint (the coordinator stays generic — it just forwards the payload it holds).
      const p = (d.payload ?? {}) as { chainId?: unknown; hopIndex?: unknown };
      await onHopSettled({ pool, hub, coordinator, config: chainConfig }, d.id, {
        status: d.status,
        output,
        hint: { chainId: p.chainId, hopIndex: p.hopIndex },
      });
    },
  });
  // Late-bind (spec §3b): the runtime's delegate route + inbound channel need
  // the coordinator, which needed the runtime's nudge — wired back here.
  runtime.setCoordinator(coordinator);

  const digest = new DigestService({
    pool,
    chain,
    resolveChain: (chainId: number) => chainRegistry.getChainOps(chainId),
    settings: { digestDefaultHourUtc: cfg.DIGEST_DEFAULT_HOUR_UTC },
  });

  // Telegram bot (S9): the whole surface exists only when the token is set.
  // All four env vars are required together — a partial config is a mistake,
  // fail fast rather than half-run.
  let telegram: { bot: TelegramBot; webhookSecret: string } | undefined;
  if (cfg.TELEGRAM_BOT_TOKEN) {
    if (!cfg.TELEGRAM_WEBHOOK_SECRET || !cfg.TELEGRAM_BOT_USERNAME || !cfg.PUBLIC_BASE_URL) {
      throw new Error(
        'TELEGRAM_BOT_TOKEN is set but TELEGRAM_WEBHOOK_SECRET / TELEGRAM_BOT_USERNAME / PUBLIC_BASE_URL are not',
      );
    }
    const bot = new TelegramBot({
      pool,
      api: new FetchTelegramApi({ botToken: cfg.TELEGRAM_BOT_TOKEN }),
      botUsername: cfg.TELEGRAM_BOT_USERNAME,
      webAppUrl: cfg.WEB_APP_URL,
      decide: { pool, hub, broker, coordinator, alerts },
    });
    alerts.setTelegramDelivery(bot.delivery());
    // /digest command: mark-and-render on demand (advances the cursor, spec §3b).
    bot.setDigestProvider(async (ownerAddr) => digest.renderText(await digest.mark(ownerAddr)));
    telegram = { bot, webhookSecret: cfg.TELEGRAM_WEBHOOK_SECRET };
    // Idempotent webhook registration at boot (S9).
    const webhookUrl = `${cfg.PUBLIC_BASE_URL.replace(/\/$/, '')}/api/telegram/webhook`;
    new FetchTelegramApi({ botToken: cfg.TELEGRAM_BOT_TOKEN })
      .setWebhook(webhookUrl, cfg.TELEGRAM_WEBHOOK_SECRET)
      .then(() => console.error(`telegram webhook registered: ${webhookUrl}`))
      .catch((err: unknown) => console.error('telegram setWebhook failed (alerts still work in-app)', err));
  }

  const batcher = new AuditBatcher({ pool, uploader });
  // §3d: the owner-stream batcher — same machinery, second source. Defers
  // per owner until the stream pubkey exists, then drains the full backlog.
  const ownerBatcher = new StreamBatcher({ pool, uploader }, ownerStreamSource);

  const appDeps = {
    pool,
    queue,
    hub,
    broker,
    // SCOPE-RH2-2: a rotation route clears the quarantine on the right batcher
    // so a previously-bad key re-flushes under the freshly-rotated one.
    onAuditKeyRotated: (stream: 'trace' | 'owner', key: string): void => {
      if (stream === 'owner') ownerBatcher.clearQuarantine(key);
      else batcher.clearQuarantine(key);
    },
    privy: createPrivyVerifier(cfg.PRIVY_APP_ID, cfg.PRIVY_APP_SECRET),
    chain,
    runtime,
    coordinator,
    alerts,
    digest,
    telegram,
    settings: {
      keyring,
      approvalTimeoutMs: cfg.APPROVAL_TIMEOUT_MS,
      sessionGasDustWei: BigInt(cfg.SESSION_GAS_DUST_WEI),
      defaultTimelockDelay: cfg.DEFAULT_TIMELOCK_DELAY,
      storageIndexerUrl: cfg.ZERO_G_STORAGE_INDEXER,
      createQuotaPerOwner: cfg.CREATE_QUOTA_PER_OWNER,
      createRatePerHour: cfg.CREATE_RATE_PER_HOUR,
      reservationTtlMs: cfg.RESERVATION_TTL_MS,
      balanceCacheTtlMs: cfg.BALANCE_CACHE_TTL_MS,
      allowlistMax: cfg.ALLOWLIST_MAX,
      rulesMax: cfg.RULES_MAX,
      elevationModel: cfg.ELEVATION_MODEL,
      delegationTtlMs: cfg.DELEGATION_TTL_MS,
      delegationRatePerLinkPerHour: cfg.DELEGATION_RATE_PER_LINK_PER_HOUR,
      delegationMaxPendingPerLink: cfg.DELEGATION_MAX_PENDING_PER_LINK,
      delegationPayloadMaxBytes: cfg.DELEGATION_PAYLOAD_MAX_BYTES,
      chainMaxDepth: cfg.CHAIN_MAX_DEPTH,
      chainMaxEligiblePerHop: cfg.CHAIN_MAX_ELIGIBLE_PER_HOP,
      capabilityCatalog: {
        ...(cfg.CAP_ROUTER_ADDR ? { router: cfg.CAP_ROUTER_ADDR.toLowerCase() } : {}),
        ...(cfg.CAP_VAULT_ADDR ? { vault: cfg.CAP_VAULT_ADDR.toLowerCase() } : {}),
        ...(cfg.CAP_SETTLEMENT_TOKEN_ADDR ? { settlement_token: cfg.CAP_SETTLEMENT_TOKEN_ADDR.toLowerCase() } : {}),
      },
      jitTtlMs: cfg.JIT_TTL_MS,
      defaultChainId,
      // SF-2: LEASH's own public base URL — the external agent points its
      // base_url here (gateway) + /mcp (tools) after a bind. Falls back to a
      // relative hint when unset (dev); prod sets PUBLIC_BASE_URL.
      publicBaseUrl: cfg.PUBLIC_BASE_URL ?? '',
    },
    // SE-7: the owner chain routes (list + second-chain onboarding) resolve
    // per-chain ops through the SAME registry the runtime uses (default-deny).
    chainRegistry,
    // SF-3: the governed MCP tool-provider rides the SF-1 seam (one-line swap
    // from denyAllProvider). Egress policy is owner/LEASH-configured via env;
    // empty config ⇒ every tool is egress-forbidden (safe default-deny).
    mcpProvider: createGovernedMcpProvider({
      pool,
      hub,
      broker,
      alerts,
      approvalTimeoutMs: cfg.APPROVAL_TIMEOUT_MS,
      jitTtlMs: cfg.JIT_TTL_MS,
      egress: createHttpMcpEgressClient(),
      loadGrant: createDbGrantLoader(pool, parseEgressConfigFromEnv()),
    }),
  };
  // M-01 split surfaces: the public server carries owner API + SSE + healthz
  // ONLY; the gateway gets its own server, ALWAYS bound to loopback.
  const ownerApp = createOwnerApp(appDeps);
  const gatewayApp = createGatewayApp(appDeps);

  // Bind the ports BEFORE the non-essential background services (batchers,
  // revoke watcher, delegation sweeper, one-shot re-drive). The DB schema +
  // runtime wiring above are already complete, so every route is correct the
  // instant it serves; opening the port first means a slow chain/storage round
  // trip in the background loops can never delay the listener past Render's
  // cold-start port-scan deadline (the Stage-E deploy footgun).
  const server = ownerApp.listen(cfg.PORT, cfg.HOST, () => {
    console.error(`leash owner API listening on ${cfg.HOST}:${cfg.PORT}`);
  });
  // M-01 timeouts. requestTimeout stays 0: SSE streams are long-lived; slow
  // clients are bounded by headersTimeout + the JSON body caps instead.
  server.headersTimeout = 15_000;
  server.requestTimeout = 0;
  server.keepAliveTimeout = 65_000;

  // Loopback-only gateway server (M-01): never reachable from off-box.
  const gatewayServer = gatewayApp.listen(cfg.GATEWAY_PORT, '127.0.0.1', () => {
    console.error(`leash gateway listening on 127.0.0.1:${cfg.GATEWAY_PORT}`);
  });
  gatewayServer.headersTimeout = 15_000;
  gatewayServer.requestTimeout = 0;
  gatewayServer.keepAliveTimeout = 65_000;
  phase('listening — ports bound');

  // Digest scheduler tick (spec §3b): 5-min cadence with a catch-up window —
  // fires when the owner's hour has passed and nothing was sent today.
  const digestTimer = setInterval(() => {
    if (!lease.held()) return; // SCOPE-I-10: only the holder sends digests (no double-send / double cursor advance)
    void digest
      .scheduledTick(new Date(), async (_ownerAddr, chatId, text) => {
        if (!telegram) return;
        await telegram.bot.sendTo(chatId, text);
      })
      .catch((err: unknown) => console.error('digest scheduler tick failed', err));
  }, 300_000);
  digestTimer.unref();

  const publicClient = createPublicClient({
    chain: zeroGChain(cfg.ZERO_G_RPC, cfg.ZERO_G_CHAIN_ID),
    transport: http(cfg.ZERO_G_RPC),
  });
  const watcher = new RevokeWatcher({
    pool,
    hub,
    runtime,
    coordinator,
    alerts,
    source: viemRevokedLogSource(publicClient),
    cursor: pgRevokeCursorStore(pool), // DM-9: durable resume + reorg rewind
    chainId: cfg.ZERO_G_CHAIN_ID,
  });

  // F-6: runtime-adjacent services (batchers, revoke watcher, delegation
  // sweeper, one-shot re-drive) start ONLY once this instance holds the
  // runtime lease. The API is already listening regardless — a non-holder
  // serves reads and refuses agent starts (RuntimeLeaseNotHeldError → 503).
  // L-01 posture kept: nothing here gates the port; acquire() polls forever.
  void lease
    .acquire()
    .then(() => {
      phase('runtime lease acquired — starting runtime services');
      batcher.start();
      ownerBatcher.start();
      watcher.start();
      // AQ-FND S1: boot reconcile FIRST (anything signed/broadcast before the last stop is resolved from the
      // ledger + chain), THEN resume the agents the owner left running (review M-8: never the other way round).
      void chainRegistry
        .reconcileAllIntents()
        .then((n) => { if (n > 0) console.error(`reconciled ${n} open transaction intent(s) on boot`); })
        .catch((err: unknown) => console.error('boot intent reconcile failed', err))
        .then(() => runtime.resumeDesired())
        .then((n) => { if (n > 0) console.error(`resumed ${n} agent(s) the owner had running`); })
        .catch((err: unknown) => console.error('agent resume on boot failed', err));
      // Expiry point B: 60s periodic sweeper for stale delegations.
      coordinator.startSweeper();
      // L-01: deferred one-shot boot re-drive (off the pre-listen path). The
      // periodic timer above still re-drives on its cadence if this is slow.
      return runtime.sweepResumableOneShots().then((n) => {
        if (n > 0) console.error(`re-drove ${n} resumable one-shot consume(s) on boot`);
        phase('background init complete');
      });
    })
    .catch((err: unknown) => console.error('runtime lease acquisition / boot re-drive failed', err));

  const shutdown = (signal: string): void => {
    console.error(`${signal} received — shutting down`);
    watcher.stop();
    batcher.stop(); // halt NEW flushes immediately; in-flight ones are drained below
    ownerBatcher.stop();
    clearInterval(digestTimer);
    clearInterval(reservationSweepTimer);
    clearInterval(directionsSweepTimer); // was previously left running on shutdown
    clearInterval(oneShotSweepTimer);
    clearInterval(settlementSweepTimer);
    clearInterval(intentReconcileTimer);
    if (railSweepTimer) clearInterval(railSweepTimer);
    coordinator.stopSweeper();
    // AQ-FND S1 (B-2): drain in-flight cycles BEFORE letting go of the lease or the pool, so a deploy
    // does not cut a send in half. `run_desired` is left as-is: the next boot resumes the same agents.
    void runtime.drain(30_000).catch((err: unknown) => console.error('runtime drain failed', err)).finally(() => {
    console.error('shutdown: runtime drained');
    lease.release();
    broker.cancelAll();
    gatewayServer.close();
    server.close(() => {
      console.error('shutdown: http server closed');
      // SCOPE-SHUTDOWN-1: drain any in-flight batch flush BEFORE ending the pool —
      // otherwise the flush's next query throws "Cannot use a pool after calling
      // end" (seen for every owner on each prior deploy's SIGTERM).
      void Promise.allSettled([batcher.drain(), ownerBatcher.drain()])
        .then(() => { console.error('shutdown: batchers drained'); return Promise.allSettled([pool.end(), leasePool.end()]); })
        .finally(() => { console.error('shutdown: pools ended — exiting'); process.exit(0); });
    });
    });
    setTimeout(() => process.exit(1), 45_000).unref(); // was 10 s: must outlast the 30 s drain (systemd TimeoutStopSec >= 60)
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('fatal startup error', err);
  process.exit(1);
});
