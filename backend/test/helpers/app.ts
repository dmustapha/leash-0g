import { randomBytes } from 'node:crypto';
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
import { DelegationCoordinator } from '../../src/coordination/coordinator.js';
import { AlertService } from '../../src/alerts/service.js';
import { DigestService } from '../../src/digest/service.js';
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

export const FAKE_GUARDIAN_ADDR = '0x' + 'ab'.repeat(20);

export class FakeChainOps implements ChainOps {
  public revoked: string[] = [];
  /** SE-1: account versions passed per create — funnel version-selection assertions. */
  public createdVersions: number[] = [];
  /** Guardian addr passed per revoke call — lane-selection assertions (C-1). */
  public revokeGuardians: Array<string | null> = [];
  public funded: Array<{ addr: string; amountWei: bigint }> = [];
  /** C-2: set to make revoke() reject like a reverted tx. */
  public revokeError: Error | null = null;
  /** Per-account forced revert (lowercased addrs) — revoke-batch partial failure. */
  public revokeErrorFor = new Set<string>();
  private nextAgentId = 100n;

  async deployAndRegister(input: {
    ownerAddr?: string;
    sessionKeyAddr: string;
    accountVersion?: 2 | 4;
    accountSalt?: string;
  }): Promise<{
    accountAddr: string;
    chainAgentId: bigint;
    createTx: string;
    registerTx: string;
    guardianAddr: string;
    accountVersion: 2 | 4;
    accountSalt: string | null;
    accountCreateTuple: import('../../src/server.js').AccountCreateTuple | null;
    adopted: boolean;
  }> {
    const accountVersion = input.accountVersion ?? 4;
    this.createdVersions.push(accountVersion);
    // SE-6 pre-req: minted addresses must be GLOBALLY unique across FakeChainOps
    // instances — a per-instance counter re-mints the same address when a test
    // file rebuilds the app against one schema, violating migration 021's
    // UNIQUE(owner_addr, chain_id, account_addr) (exactly what a real factory
    // never does: every real mint is a fresh contract address).
    const uniquePrefix = randomBytes(15).toString('hex'); // 30 hex chars
    return {
      accountAddr: `0x${uniquePrefix}${(this.nextAgentId + 1000n).toString(16).padStart(10, '0')}`,
      chainAgentId: this.nextAgentId++,
      createTx: '0x' + '11'.repeat(32),
      registerTx: '0x' + '22'.repeat(32),
      guardianAddr: FAKE_GUARDIAN_ADDR,
      accountVersion,
      // SE-6 mirror of the ops layer: a V4 mint carries its CREATE2 salt + the
      // exact canonical construction tuple it was minted with.
      accountSalt: accountVersion === 4 ? (input.accountSalt ?? '0x' + 'a5'.repeat(32)) : null,
      accountCreateTuple:
        accountVersion === 4
          ? {
              ownerAddr: (input.ownerAddr ?? '0x' + 'a1'.repeat(20)).toLowerCase(),
              guardianAddr: FAKE_GUARDIAN_ADDR.toLowerCase(),
              sessionKeyAddr: input.sessionKeyAddr.toLowerCase(),
              policy: { perTransferCap: '1', windowCap: '2', windowSeconds: 3600, expiresAt: 2 ** 31 - 1 },
              allowlist: [],
              timelockDelay: 900,
              settlementToken: '0x' + '00'.repeat(20),
              tokenPolicy: { perTransferCapToken: '0', windowCapToken: '0' },
            }
          : null,
      adopted: false,
    };
  }

  async revoke(accountAddr: string, accountGuardianAddr?: string | null): Promise<{ txHash: string }> {
    if (this.revokeError) throw this.revokeError;
    if (this.revokeErrorFor.has(accountAddr.toLowerCase())) {
      throw new Error(`guardian revoke tx reverted on-chain for ${accountAddr}`);
    }
    this.revoked.push(accountAddr.toLowerCase());
    this.revokeGuardians.push(accountGuardianAddr ?? null);
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
    spentInWindow: 0n,
    windowStart: Math.floor(Date.now() / 1000),
  };

  public balances = new Map<string, bigint>();
  /** M-03: live on-chain guardian per account (lowercased addrs). */
  public onchainGuardians = new Map<string, string>();

  async getPolicyView(): Promise<PolicyView> {
    return this.policyView;
  }

  async getGuardian(accountAddr: string): Promise<string> {
    return this.onchainGuardians.get(accountAddr.toLowerCase()) ?? FAKE_GUARDIAN_ADDR;
  }

  async getBalance(addr: string): Promise<bigint> {
    return this.balances.get(addr.toLowerCase()) ?? 0n;
  }
}

export class FakeRuntime implements RuntimeManager {
  public running = new Set<string>();
  public halted: string[] = [];
  /** Delegation delivery nudges, in order (spec §3b — latency optimization only). */
  public nudges: string[] = [];

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

  nudge(agentId: string): void {
    this.nudges.push(agentId);
  }

  /** SE-2: records the requestIds a one-shot consume was triggered for. */
  public oneShotConsumes: Array<{ agentId: string; requestId: string }> = [];
  async consumeApprovedOneShot(agentId: string, requestId: string): Promise<void> {
    this.oneShotConsumes.push({ agentId, requestId });
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
  coordinator: DelegationCoordinator;
  alerts: AlertService;
  deps: AppDeps;
}

export function testSettings(overrides: Partial<AppDeps['settings']> = {}): AppDeps['settings'] {
  return {
    keyEncryptionSecret: TEST_KEK,
    approvalTimeoutMs: 10_000,
    sessionGasDustWei: 10n ** 15n,
    defaultTimelockDelay: 900,
    storageIndexerUrl: 'https://indexer.leash-test.local',
    createQuotaPerOwner: 1000,
    createRatePerHour: 1000,
    reservationTtlMs: 120_000,
    balanceCacheTtlMs: 15_000,
    allowlistMax: 16,
    rulesMax: 32,
    elevationModel: 'test-elevation-model',
    // Delegation bounds: the REAL production defaults (spec §5) — throttle
    // tests must exercise what ships; individual tests override deliberately.
    delegationTtlMs: 600_000,
    delegationRatePerLinkPerHour: 12,
    delegationMaxPendingPerLink: 3,
    delegationPayloadMaxBytes: 16_384,
    chainMaxDepth: 3,
    chainMaxEligiblePerHop: 3,
    // Stage D: a resolvable mock catalog so preset-apply tests exercise the real path.
    capabilityCatalog: {
      router: '0x' + 'd0'.repeat(20),
      vault: '0x' + 'e0'.repeat(20),
      settlement_token: '0x' + 'c0'.repeat(20),
    },
    jitTtlMs: 600_000,
    defaultChainId: 16602,
    publicBaseUrl: 'https://leash-test.local',
    ...overrides,
  };
}

export function buildTestApp(pool: Pool, overrides: Partial<AppDeps> = {}): TestApp {
  const hub = new SseHub();
  // S8 owner fan-out — same lookup wiring as the composition root.
  hub.setOwnerLookup(async (agentId) => {
    const res = await pool.query<{ owner_addr: string }>(`SELECT owner_addr FROM agents WHERE id = $1`, [agentId]);
    return res.rows[0]?.owner_addr ?? null;
  });
  const broker = new ApprovalBroker();
  const chain = new FakeChainOps();
  const runtime = new FakeRuntime();
  const settings = overrides.settings ?? testSettings();
  const alerts =
    overrides.alerts ??
    new AlertService({
      pool,
      hub: overrides.hub ?? hub,
      settings: { alertRatePerOwnerPerHour: 1000 },
    });
  const digest =
    overrides.digest ??
    new DigestService({ pool, chain: overrides.chain ?? chain, settings: { digestDefaultHourUtc: 8 } });
  const coordinator =
    overrides.coordinator ??
    new DelegationCoordinator({
      pool,
      hub: overrides.hub ?? hub,
      runtime: overrides.runtime ?? runtime,
      alerts,
      settings,
    });
  const deps: AppDeps = {
    pool,
    queue: new ComputeQueue({ baseUrl: `${UPSTREAM}/v1`, apiKey: 'upstream-key', baseDelayMs: 5, maxRetries: 2 }),
    hub,
    broker,
    privy: fakePrivy,
    chain,
    runtime,
    coordinator,
    alerts,
    digest,
    settings,
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
    coordinator: deps.coordinator,
    alerts: deps.alerts,
    deps,
  };
}
