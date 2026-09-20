import type { Pool } from 'pg';
import type { Express } from 'express';
import {
  createApp,
  createOwnerApp,
  createGatewayApp,
  type AppDeps,
  type ChainOps,
  type RuntimeManager,
} from '../../src/server.js';
import { ComputeQueue } from '../../src/gateway/compute-queue.js';
import { SseHub } from '../../src/sse/hub.js';
import { ApprovalBroker } from '../../src/approvals/broker.js';
import type { PrivyVerifier } from '../../src/api/privy.js';
import type { PolicyView } from '../../src/types.js';

export const TEST_KEK = 'ab'.repeat(32);
export const UPSTREAM = 'http://compute.leash-test.local';

/** Fake Privy verifier: `Bearer owner:<addr>` → that owner. */
export const fakePrivy: PrivyVerifier = {
  async verify(authHeader) {
    const m = /^Bearer owner:(0x[0-9a-fA-F]{40})$/.exec(authHeader ?? '');
    if (!m?.[1]) throw new Error('unauthorized');
    return { ownerAddr: m[1].toLowerCase() };
  },
};

export function ownerAuth(addr: string): string {
  return `Bearer owner:${addr}`;
}

export class FakeChainOps implements ChainOps {
  public revoked: string[] = [];
  public funded: Array<{ addr: string; amountWei: bigint }> = [];
  private nextAgentId = 100n;

  async deployAndRegister(input: { sessionKeyAddr: string }): Promise<{
    accountAddr: string;
    chainAgentId: bigint;
    createTx: string;
    registerTx: string;
  }> {
    void input;
    return {
      accountAddr: `0x${(this.nextAgentId + 1000n).toString(16).padStart(40, '0')}`,
      chainAgentId: this.nextAgentId++,
      createTx: '0x' + '11'.repeat(32),
      registerTx: '0x' + '22'.repeat(32),
    };
  }

  async revoke(accountAddr: string): Promise<{ txHash: string }> {
    this.revoked.push(accountAddr.toLowerCase());
    return { txHash: '0x' + '33'.repeat(32) };
  }

  async fundSessionKey(addr: string, amountWei: bigint): Promise<{ txHash: string }> {
    this.funded.push({ addr, amountWei });
    return { txHash: '0x' + '44'.repeat(32) };
  }

  public policyView: PolicyView = {
    perTransferCap: 10n ** 16n,
    windowCap: 3n * 10n ** 16n,
    windowSeconds: 3600,
    expiresAt: Math.floor(Date.now() / 1000) + 86_400,
    allowlist: [],
    revoked: false,
  };

  public balances = new Map<string, bigint>();

  async getPolicyView(): Promise<PolicyView> {
    return this.policyView;
  }

  async getBalance(addr: string): Promise<bigint> {
    return this.balances.get(addr.toLowerCase()) ?? 0n;
  }
}

export class FakeRuntime implements RuntimeManager {
  public running = new Set<string>();
  public halted: string[] = [];

  async start(agentId: string): Promise<void> {
    this.running.add(agentId);
  }

  async stop(agentId: string): Promise<void> {
    this.running.delete(agentId);
  }

  isRunning(agentId: string): boolean {
    return this.running.has(agentId);
  }

  async haltForRevoke(agentId: string): Promise<void> {
    this.running.delete(agentId);
    this.halted.push(agentId);
  }
}

export interface TestApp {
  /** Both surfaces on one app — in-process convenience mirroring the split. */
  app: Express;
  /** Public surface only (owner API + SSE + healthz) — what HOST:PORT serves. */
  ownerApp: Express;
  /** Gateway surface only — what 127.0.0.1:GATEWAY_PORT serves. */
  gatewayApp: Express;
  hub: SseHub;
  broker: ApprovalBroker;
  chain: FakeChainOps;
  runtime: FakeRuntime;
  deps: AppDeps;
}

export function buildTestApp(pool: Pool, overrides: Partial<AppDeps> = {}): TestApp {
  const hub = new SseHub();
  const broker = new ApprovalBroker();
  const chain = new FakeChainOps();
  const runtime = new FakeRuntime();
  const deps: AppDeps = {
    pool,
    queue: new ComputeQueue({ baseUrl: `${UPSTREAM}/v1`, apiKey: 'upstream-key', baseDelayMs: 5, maxRetries: 2 }),
    hub,
    broker,
    privy: fakePrivy,
    chain,
    runtime,
    settings: {
      keyEncryptionSecret: TEST_KEK,
      approvalTimeoutMs: 10_000,
      sessionGasDustWei: 10n ** 15n,
      defaultTimelockDelay: 900,
      storageIndexerUrl: 'https://indexer.leash-test.local',
    },
    ...overrides,
  };
  return {
    app: createApp(deps),
    ownerApp: createOwnerApp(deps),
    gatewayApp: createGatewayApp(deps),
    hub,
    broker,
    chain,
    runtime,
    deps,
  };
}
