import 'dotenv/config';
import { createPublicClient, http } from 'viem';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { createApp } from './server.js';
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

/** Composition root: wire every module, migrate, listen, run the loops. */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const pool = createPool(cfg.DATABASE_URL);
  const applied = await migrate(pool);
  if (applied.length > 0) console.error(`migrations applied: ${applied.join(', ')}`);

  const checkpointer = new PostgresSaver(pool, undefined, { schema: 'public' });
  await checkpointer.setup();

  const hub = new SseHub();
  const broker = new ApprovalBroker();
  const queue = new ComputeQueue({ baseUrl: cfg.COMPUTE_BASE_URL, apiKey: cfg.ZERO_G_COMPUTE_API_KEY });
  const chain = new LeashChainOps({
    rpcUrl: cfg.ZERO_G_RPC,
    chainId: cfg.ZERO_G_CHAIN_ID,
    opsPrivateKey: cfg.OPS_PRIVATE_KEY,
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
      gatewayUrl: `http://127.0.0.1:${cfg.PORT}`, // the runtime is the gateway's only client
      intervalMs: cfg.RUNTIME_INTERVAL_MS,
      defaultModel: cfg.RUNTIME_DEFAULT_MODEL,
    },
  });

  const app = createApp({
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
    },
  });

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

  const server = app.listen(cfg.PORT, cfg.HOST, () => {
    console.error(`leash backend listening on ${cfg.HOST}:${cfg.PORT}`);
  });
  // M-01 timeouts. requestTimeout stays 0: SSE streams are long-lived; slow
  // clients are bounded by headersTimeout + the JSON body caps instead.
  server.headersTimeout = 15_000;
  server.requestTimeout = 0;
  server.keepAliveTimeout = 65_000;

  const shutdown = (signal: string): void => {
    console.error(`${signal} received — shutting down`);
    watcher.stop();
    batcher.stop();
    broker.cancelAll();
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
