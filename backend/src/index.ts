import 'dotenv/config';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { createOwnerApp, createGatewayApp } from './server.js';
import { ComputeQueue } from './gateway/compute-queue.js';
import { SseHub } from './sse/hub.js';
import { ApprovalBroker } from './approvals/broker.js';
import { createPrivyVerifier } from './api/privy.js';
import { LeashChainOps, zeroGChain } from './chain/ops.js';
import { RevokeWatcher } from './chain/revoke-watcher.js';
import { viemRevokedLogSource } from './chain/log-source.js';
import { AuditBatcher, StreamBatcher, ownerStreamSource } from './audit/batcher.js';
import { ZeroGStorage } from './audit/storage.js';
import { SessionChain } from './runtime/session-chain.js';
import { LeashRuntimeManager } from './runtime/manager.js';
import { backfillLegacyGuardian } from './store/agents.js';
import { sweepStaleReservations } from './store/reservations.js';
import { sweepOrphanedApprovals } from './approvals/sweep.js';
import { DelegationCoordinator, runBootSweep } from './coordination/coordinator.js';
import { AlertService } from './alerts/service.js';
import { TelegramBot } from './telegram/bot.js';
import { FetchTelegramApi } from './telegram/api.js';
import { DigestService } from './digest/service.js';
import { getAgentById } from './store/agents.js';

/** Composition root: wire every module, migrate, listen, run the loops. */
async function main(): Promise<void> {
  const cfg = loadConfig();
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
  const reservationSweepTimer = setInterval(() => {
    void sweepStaleReservations(pool, cfg.RESERVATION_TTL_MS).catch((err: unknown) =>
      console.error('reservation sweep tick failed', err),
    );
  }, cfg.RESERVATION_TTL_MS);
  reservationSweepTimer.unref();

  const checkpointer = new PostgresSaver(pool, undefined, { schema: 'public' });
  if (migratePool === pool) {
    await checkpointer.setup();
  } else {
    // setup() is DDL — run it on the admin pool, then release it.
    await new PostgresSaver(migratePool, undefined, { schema: 'public' }).setup();
    await migratePool.end();
  }

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
  const queue = new ComputeQueue({ baseUrl: cfg.COMPUTE_BASE_URL, apiKey: cfg.ZERO_G_COMPUTE_API_KEY });
  const chain = new LeashChainOps({
    rpcUrl: cfg.ZERO_G_RPC,
    chainId: cfg.ZERO_G_CHAIN_ID,
    opsPrivateKey: cfg.OPS_PRIVATE_KEY,
    guardianPrivateKey: cfg.GUARDIAN_PRIVATE_KEY,
    factoryAddr: cfg.LEASH_FACTORY_ADDR,
    registryAddr: cfg.AGENT_REGISTRY_ADDR,
  });

  // 0G Storage Log Layer wrapper — the audit batcher's sink AND the Phase-4
  // job graph's deliverable/PoA sink (built here so the runtime can thread it).
  const uploader = new ZeroGStorage({
    indexerUrl: cfg.ZERO_G_STORAGE_INDEXER,
    rpcUrl: cfg.ZERO_G_RPC,
    opsPrivateKey: cfg.OPS_PRIVATE_KEY,
  });

  const runtime = new LeashRuntimeManager({
    pool,
    hub,
    broker,
    alerts,
    uploader,
    chain: new SessionChain({ rpcUrl: cfg.ZERO_G_RPC, chainId: cfg.ZERO_G_CHAIN_ID }),
    checkpointer,
    settings: {
      keyEncryptionSecret: cfg.KEY_ENCRYPTION_SECRET,
      approvalTimeoutMs: cfg.APPROVAL_TIMEOUT_MS,
      gatewayUrl: `http://127.0.0.1:${cfg.GATEWAY_PORT}`, // the runtime is the gateway's only client
      intervalMs: cfg.RUNTIME_INTERVAL_MS,
      defaultModel: cfg.RUNTIME_DEFAULT_MODEL,
      jobProviderModel: cfg.JOB_PROVIDER_MODEL,
      jobEvaluatorModel: cfg.JOB_EVALUATOR_MODEL,
    },
  });

  // Coordination layer (spec §3b): links/delegations lifecycle + channel
  // throttles + expiry sweeper. The nudge is delivery-latency only.
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
  });
  // Late-bind (spec §3b): the runtime's delegate route + inbound channel need
  // the coordinator, which needed the runtime's nudge — wired back here.
  runtime.setCoordinator(coordinator);

  const digest = new DigestService({
    pool,
    chain,
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

  const appDeps = {
    pool,
    queue,
    hub,
    broker,
    privy: createPrivyVerifier(cfg.PRIVY_APP_ID, cfg.PRIVY_APP_SECRET),
    chain,
    runtime,
    coordinator,
    alerts,
    digest,
    telegram,
    settings: {
      keyEncryptionSecret: cfg.KEY_ENCRYPTION_SECRET,
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
      delegationTtlMs: cfg.DELEGATION_TTL_MS,
      delegationRatePerLinkPerHour: cfg.DELEGATION_RATE_PER_LINK_PER_HOUR,
      delegationMaxPendingPerLink: cfg.DELEGATION_MAX_PENDING_PER_LINK,
      delegationPayloadMaxBytes: cfg.DELEGATION_PAYLOAD_MAX_BYTES,
    },
  };
  // M-01 split surfaces: the public server carries owner API + SSE + healthz
  // ONLY; the gateway gets its own server, ALWAYS bound to loopback.
  const ownerApp = createOwnerApp(appDeps);
  const gatewayApp = createGatewayApp(appDeps);

  const batcher = new AuditBatcher({ pool, uploader });
  batcher.start();
  // §3d: the owner-stream batcher — same machinery, second source. Defers
  // per owner until the stream pubkey exists, then drains the full backlog.
  const ownerBatcher = new StreamBatcher({ pool, uploader }, ownerStreamSource);
  ownerBatcher.start();

  // Digest scheduler tick (spec §3b): 5-min cadence with a catch-up window —
  // fires when the owner's hour has passed and nothing was sent today.
  const digestTimer = setInterval(() => {
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
  const watcher = new RevokeWatcher({ pool, hub, runtime, coordinator, alerts, source: viemRevokedLogSource(publicClient) });
  watcher.start();
  // Expiry point B: 60s periodic sweeper for stale delegations.
  coordinator.startSweeper();

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

  const shutdown = (signal: string): void => {
    console.error(`${signal} received — shutting down`);
    watcher.stop();
    batcher.stop();
    ownerBatcher.stop();
    clearInterval(digestTimer);
    coordinator.stopSweeper();
    clearInterval(reservationSweepTimer);
    broker.cancelAll();
    gatewayServer.close();
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('fatal startup error', err);
  process.exit(1);
});
