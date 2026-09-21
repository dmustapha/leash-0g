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
import { AuditBatcher } from './audit/batcher.js';
import { ZeroGStorage } from './audit/storage.js';
import { SessionChain } from './runtime/session-chain.js';
import { LeashRuntimeManager } from './runtime/manager.js';
import { backfillLegacyGuardian } from './store/agents.js';
import { sweepOrphanedApprovals } from './approvals/sweep.js';

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

  const checkpointer = new PostgresSaver(pool, undefined, { schema: 'public' });
  if (migratePool === pool) {
    await checkpointer.setup();
  } else {
    // setup() is DDL — run it on the admin pool, then release it.
    await new PostgresSaver(migratePool, undefined, { schema: 'public' }).setup();
    await migratePool.end();
  }

  const hub = new SseHub();
  const broker = new ApprovalBroker();
  const queue = new ComputeQueue({ baseUrl: cfg.COMPUTE_BASE_URL, apiKey: cfg.ZERO_G_COMPUTE_API_KEY });
  const chain = new LeashChainOps({
    rpcUrl: cfg.ZERO_G_RPC,
    chainId: cfg.ZERO_G_CHAIN_ID,
    opsPrivateKey: cfg.OPS_PRIVATE_KEY,
    guardianPrivateKey: cfg.GUARDIAN_PRIVATE_KEY,
    factoryAddr: cfg.LEASH_FACTORY_ADDR,
    registryAddr: cfg.AGENT_REGISTRY_ADDR,
  });

  const runtime = new LeashRuntimeManager({
    pool,
    hub,
    broker,
    chain: new SessionChain({ rpcUrl: cfg.ZERO_G_RPC, chainId: cfg.ZERO_G_CHAIN_ID }),
    checkpointer,
    settings: {
      keyEncryptionSecret: cfg.KEY_ENCRYPTION_SECRET,
      approvalTimeoutMs: cfg.APPROVAL_TIMEOUT_MS,
      gatewayUrl: `http://127.0.0.1:${cfg.GATEWAY_PORT}`, // the runtime is the gateway's only client
      intervalMs: cfg.RUNTIME_INTERVAL_MS,
      defaultModel: cfg.RUNTIME_DEFAULT_MODEL,
    },
  });

  const appDeps = {
    pool,
    queue,
    hub,
    broker,
    privy: createPrivyVerifier(cfg.PRIVY_APP_ID, cfg.PRIVY_APP_SECRET),
    chain,
    runtime,
    settings: {
      keyEncryptionSecret: cfg.KEY_ENCRYPTION_SECRET,
      approvalTimeoutMs: cfg.APPROVAL_TIMEOUT_MS,
      sessionGasDustWei: BigInt(cfg.SESSION_GAS_DUST_WEI),
      defaultTimelockDelay: cfg.DEFAULT_TIMELOCK_DELAY,
      storageIndexerUrl: cfg.ZERO_G_STORAGE_INDEXER,
      createQuotaPerOwner: cfg.CREATE_QUOTA_PER_OWNER,
      createRatePerHour: cfg.CREATE_RATE_PER_HOUR,
      allowlistMax: cfg.ALLOWLIST_MAX,
      rulesMax: cfg.RULES_MAX,
    },
  };
  // M-01 split surfaces: the public server carries owner API + SSE + healthz
  // ONLY; the gateway gets its own server, ALWAYS bound to loopback.
  const ownerApp = createOwnerApp(appDeps);
  const gatewayApp = createGatewayApp(appDeps);

  const batcher = new AuditBatcher({
    pool,
    uploader: new ZeroGStorage({
      indexerUrl: cfg.ZERO_G_STORAGE_INDEXER,
      rpcUrl: cfg.ZERO_G_RPC,
      opsPrivateKey: cfg.OPS_PRIVATE_KEY,
    }),
  });
  batcher.start();

  const publicClient = createPublicClient({
    chain: zeroGChain(cfg.ZERO_G_RPC, cfg.ZERO_G_CHAIN_ID),
    transport: http(cfg.ZERO_G_RPC),
  });
  const watcher = new RevokeWatcher({ pool, hub, runtime, source: viemRevokedLogSource(publicClient) });
  watcher.start();

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
