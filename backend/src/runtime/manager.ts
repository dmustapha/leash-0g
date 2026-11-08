import { classifyCycleResult, classifyThrown, describeTrip, recordCycleResult, resetBreakers, type FailureClass } from './typed-breakers.js';
import { makeCallLabeler } from '../asset/labeler.js';
import { describeDecodedCall } from '../asset/describe-call.js';
import { randomUUID } from 'node:crypto';
import { Command, type BaseCheckpointSaver } from '@langchain/langgraph';
import type { Pool } from 'pg';
import type { RuntimeManager } from '../server.js';
import type { SseHub } from '../sse/hub.js';
import type { ApprovalBroker, ApprovalDecision } from '../approvals/broker.js';
import { getAgentById } from '../store/agents.js';
import { expireApproval } from '../store/approvals.js';
import { listResumableOneShots } from '../store/capabilities.js';
import { awaitApprovalDecision, decidedInDb } from '../approvals/rendezvous.js';
import { decryptSecret, type Keyring } from '../crypto/keycrypt.js';
import { appendTrace } from '../trace/trace-store.js';
import { traceEvent } from '../sse/events.js';
import type { AgentRow } from '../types.js';
import { goalRole, assertNativeAgent } from '../types.js';
import type { DelegationCoordinator } from '../coordination/coordinator.js';
import type { AlertService } from '../alerts/service.js';
import { BoundaryRegistry } from './boundary.js';
import { listActivatablePendingFor } from '../coordination/store.js';
import { listAdvancingChainsForOrigin } from '../store/chains.js';
import {
  DEFAULT_CHAIN_CONFIG,
  proposeNextHop,
  selectHopTargetViaGateway,
  type ChainConfig,
  type ChainDeps,
  type HopSelection,
} from '../coordination/chain.js';
import type { Json } from '../crypto/canonical.js';
import type { RuntimeChain } from './session-chain.js';
import { loadGasRouteInputs } from './gas.js';
import type { ChainRegistry } from '../chain/registry.js';
import { assertBridgeRoutable } from './bridge-gate.js';
import { describeCycleFailure, rawErrorText } from './cycle-failure.js';
import { budgetExhausted, nextCycleDelayMs, DEFAULT_FAILURE_BUDGET, DEFAULT_MAX_BACKOFF_MS } from './failure-budget.js';
import { buildTreasuryGraph, PARSE_MISS_REASON, type TreasuryGraph } from './treasury-graph.js';
import { consumeOneShot } from './one-shot-consume.js';
import type { CapabilityDeps } from '../capabilities/service.js';
import { defaultToolRegistry } from '../tool-use/index.js';
import { createDbGrantLoader } from '../gateway/mcp/governed-provider.js';
import { defaultSigningRegistry } from '../signing/index.js';
import { listSigningRules, getSigningRequest, recordSigningArm } from '../store/signing.js';
import { createHttpMcpEgressClient, parseEgressConfigFromEnv } from '../gateway/mcp/egress.js';
import { buildJobGraph, type JobGraph } from '../jobs/graph.js';
import type { StorageUploader } from '../audit/batcher.js';
import type { InboundDelegationInput } from './prompt.js';

/** SE-2: bounded backoff so a slightly-late authorizeOnce still gets consumed. */
const ONE_SHOT_CONSUME_MAX_ATTEMPTS = 6;
const ONE_SHOT_CONSUME_RETRY_MS = 2_000;

export interface RuntimeSettings {
  keyring: Keyring;
  approvalTimeoutMs: number;
  /** Base URL of OUR OWN gateway (loopback in prod) — set after listen(). */
  gatewayUrl: string;
  intervalMs: number;
  defaultModel: string;
  /** §0.6/F8 strong models for the ACP reasoning roles (fall back to defaultModel). */
  jobProviderModel?: string | undefined;
  jobEvaluatorModel?: string | undefined;
  /** Phase 5.6 chaining bounds (depth cap + eligible-set cap; defaults if unset). */
  chainConfig?: ChainConfig | undefined;
  /** Stage D (D-8): how long a JIT capability card stays actionable (ms; default 10 min). */
  jitTtlMs?: number | undefined;
  /** E1 loop-breaker: consecutive failed cycles before the agent pauses itself (default 5; 0 disables). */
  failureBudget?: number | undefined;
  /** E1: cap on the exponential delay between cycles while an agent is failing (default 15 min). */
  maxBackoffMs?: number | undefined;
  /** inc-3b: a CCTP MessageTransmitter is configured, so the ops key can complete a fill. Without it the gas route never starts a burn. */
  cctpFillEnabled?: boolean | undefined;
  /** AQ-FND M-3: global session-key gas dust default (wei) — used by the gas ladder when a
   *  chain does not override `sessionGasDustWei`. Unset ⇒ 0.002 0G (the config default). */
  globalDustWei?: bigint | undefined;
  fetchFn?: typeof fetch;
}

export interface RuntimeManagerDeps {
  pool: Pool;
  hub: SseHub;
  broker: ApprovalBroker;
  chain: RuntimeChain;
  /**
   * SE-7 (SE-5 Gate-② carry #2): resolve the RUNTIME chain client for an
   * agent's chainId (ChainRegistry.getSessionChain in production). Optional —
   * absent (single-chain test setups) falls back to `chain`. Consumed by the
   * one-shot consume/sweep so a chain-B one-shot is never re-driven against
   * chain-A's client.
   */
  resolveChain?: ((chainId: number) => RuntimeChain) | undefined;
  /**
   * SE-8: the full ChainRegistry — the treasury graph's bridge lane needs the
   * agent chain's `bridgeAllowlist`/`bridgeDestinations` (classify enforcement,
   * carry #2) and `assertSameAddress` (the HARD pre-routing gate, carry #1).
   * Optional: absent (single-chain test setups) = no bridge lane (fail-closed).
   */
  chainRegistry?: ChainRegistry | undefined;
  checkpointer: BaseCheckpointSaver;
  /** Phase-3 alert engine (optional in coordination-free test setups). */
  alerts?: AlertService | undefined;
  /**
   * Phase-4: 0G Storage Log Layer uploader — the provider/evaluator job graphs
   * write the deliverable + rationale here (ECIES owner-only). Absent only in
   * treasury-only test setups (the job graph is never built then).
   */
  uploader?: StorageUploader | undefined;
  /**
   * F-6: the DB-level runtime lease — when wired, start() refuses while
   * another backend instance holds it (two backends sharing one DB must
   * never double-loop the same agents). Optional: absent in test setups.
   */
  lease?: { held(): boolean } | undefined;
  settings: RuntimeSettings;
  /** Test seam: replaces the hard bridge-gate (its own suite proves it). Production leaves this unset. */
  bridgeGate?: typeof assertBridgeRoutable | undefined;
}

/** F-6: thrown by start() when this instance does not hold the runtime lease. */
export class RuntimeLeaseNotHeldError extends Error {
  constructor() {
    super('the runtime lease is held by another backend instance — agent loops are disabled here');
    this.name = 'RuntimeLeaseNotHeldError';
  }
}

interface Loop {
  stopped: boolean;
  timer: NodeJS.Timeout | null;
  current: Promise<void>;
  /** True while a cycle is executing — nudge() must not double-schedule then. */
  busy: boolean;
  /** E1: consecutive cycles that threw; reset by any cycle that returns. */
  consecutiveFailures: number;
  pendingApprovalId: string | null;
  /** Either the treasury/transfer graph or the Phase-4 ACP job graph — both
   * share the manager contract: invoke({inboundDelegation}), a pending
   * interrupt on getState().tasks[].interrupts, resume via Command. */
  graph: TreasuryGraph | JobGraph;
  agent: AgentRow;
  /** Decrypted gateway token — Phase 5.6 uses it for the isolated hop selector. */
  gatewayToken: string;
}

/**
 * Hosts the ONE LEASH-created agent per row (spec §3b): start() decrypts the
 * scoped session key + gateway token (the ONLY secrets the runtime holds),
 * builds the treasury graph on the Postgres checkpointer, and drives a
 * polling loop — each cycle is one graph run. interrupt() pauses surface via
 * getState().tasks[].interrupts (spike learning); the owner's decision
 * arrives through the ApprovalBroker, gets a durable consent record BEFORE
 * the resume, then the run continues. Revoke fan-out halts everything.
 */
export class LeashRuntimeManager implements RuntimeManager {
  private readonly loops = new Map<string, Loop>();

  /**
   * Late-bound (spec §3b): the coordinator is constructed AFTER the manager
   * (it needs the manager's nudge), so the composition root wires it back in
   * via setCoordinator(). Graphs capture a getter, never the instance —
   * loops started before binding still see it. Null = coordination-free
   * setup: the inbound channel is idle and the delegate route fails traced.
   */
  private coordinator: DelegationCoordinator | null = null;

  /** P3C-6(iii): active policy boundaries, shared across cycles (damping). */
  private readonly boundaries = new BoundaryRegistry();

  private draining = false;

  constructor(private readonly deps: RuntimeManagerDeps) {}

  setCoordinator(coordinator: DelegationCoordinator): void {
    this.coordinator = coordinator;
  }

  /** Stage D: the capability service deps for the JIT rail (undefined without alerts). */
  private capabilityDeps(): CapabilityDeps | undefined {
    if (!this.deps.alerts) return undefined;
    return {
      pool: this.deps.pool,
      hub: this.deps.hub,
      broker: this.deps.broker,
      alerts: this.deps.alerts,
      jitTtlMs: this.deps.settings.jitTtlMs ?? 600_000,
      describeCall: (chainId, d) => this.describeCall(chainId, d),
    };
  }

  /** Beta step 3b: label a decoded call with the token's symbol/decimals and well-known contract names. */
  private async describeCall(chainId: number, d: Parameters<typeof describeDecodedCall>[0]): Promise<string> {
    const registry = this.deps.chainRegistry;
    if (!registry?.has(chainId)) return d.humanReadable;
    const ops = registry.getChainOps(chainId);
    const cfg = registry.getChainConfig(chainId);
    return describeDecodedCall(d, chainId, makeCallLabeler(ops, cfg));
  }

  /**
   * SF-3: the governed tool-use rail (undefined without alerts — raiseToolRequest
   * needs the alert engine). Egress policy is read from env (same as the gateway
   * wiring); empty config ⇒ every tool is egress-forbidden → tool_call stands down
   * (safe default-deny). The runtime shares the gateway's tool-gate + egress leg.
   */
  private toolRailDeps(): import('./treasury-graph.js').ToolRail | undefined {
    const alerts = this.deps.alerts;
    if (!alerts) return undefined;
    return {
      registry: defaultToolRegistry,
      loadGrant: createDbGrantLoader(this.deps.pool, parseEgressConfigFromEnv()),
      service: {
        pool: this.deps.pool,
        hub: this.deps.hub,
        broker: this.deps.broker,
        alerts,
        registry: defaultToolRegistry,
        jitTtlMs: this.deps.settings.jitTtlMs ?? 600_000,
      },
      executor: createHttpMcpEgressClient(),
    };
  }

  /**
   * FP-3: the governed signing rail deps. Only wired when the alert engine is present (the JIT rail
   * `raiseSigningRequest` needs it). `loadGrant` live-reads the owner's signing-rule mirror from the
   * read-model (the on-chain wall stays authoritative; `signingEpoch` is unused in the decide path —
   * the arm tx reads the real epoch for the read-model record). Absent ⇒ a `sign` stands down.
   */
  private signingRailDeps(): import('./treasury-graph.js').SigningRail | undefined {
    const alerts = this.deps.alerts;
    if (!alerts) return undefined;
    return {
      registry: defaultSigningRegistry,
      loadGrant: async (agentId: string) => {
        const rows = await listSigningRules(this.deps.pool, agentId);
        const rules = new Map<number, import('../signing/index.js').SigningRule>();
        for (const r of rows) {
          if (r.status !== 'active') continue;
          rules.set(r.descriptorId, {
            descriptorId: r.descriptorId,
            spenderSet: r.spenderSet,
            perIntentCap: r.perIntentCap,
            maxDeadlineWindow: r.maxDeadlineWindow,
            token: r.token,
            active: true,
          });
        }
        return { rules, signingEpoch: 0 };
      },
      resolvePins: async ({ agentId, descriptorId }) => {
        // Server-held pins for non-role leaves. `token` = the granted budget token (Permit2's `token`
        // leaf). `nonce` defaults to 0 — our wall never validates the permit nonce (the downstream
        // protocol does); the live drill reads the real nonce when a specific protocol requires it.
        const rows = await listSigningRules(this.deps.pool, agentId);
        const rule = rows.find((r) => r.descriptorId === descriptorId && r.status === 'active');
        const pins: Record<string, string | number | bigint | boolean> = { nonce: 0 };
        if (rule) pins['token'] = rule.token;
        return pins;
      },
      service: {
        pool: this.deps.pool,
        hub: this.deps.hub,
        broker: this.deps.broker,
        alerts,
        jitTtlMs: this.deps.settings.jitTtlMs ?? 600_000,
      },
    };
  }

  /**
   * SE-8: the treasury graph's bridge-lane deps for one agent — the chain's
   * bridge allowlist (classify enforcement) + the HARD pre-routing gate
   * (`assertBridgeRoutable` → `ChainRegistry.assertSameAddress`, carry #1).
   * Undefined when no registry is wired or the agent's chain allows no bridges.
   */
  private bridgeDeps(agent: AgentRow): { bridge: NonNullable<import('./treasury-graph.js').TreasuryGraphDeps['bridge']> } | undefined {
    const registry = this.deps.chainRegistry;
    if (!registry || !registry.has(agent.chainId)) return undefined;
    const allow = registry.getChainConfig(agent.chainId).bridgeAllowlist ?? [];
    if (allow.length === 0) return undefined;
    return {
      bridge: {
        targets: new Set(allow.map((a) => a.toLowerCase())),
        assertRoutable: (bridgeTarget, decoded, srcChainId) => (this.deps.bridgeGate ?? assertBridgeRoutable)(registry, agent, bridgeTarget, decoded, srcChainId),
      },
    };
  }

  /**
   * AQ-FND M-3: the self-funding gas-ladder deps for a treasury agent — the chain
   * config the ladder reads (`buildGasRouteConfig`) plus the multi-chain survey inputs.
   * Both come from the registry; absent registry/chain ⇒ no ladder (the token top-up acts
   * as the native path, no regression). There is no relayer/sponsored rung.
   */
  private gasDeps(agent: AgentRow): {
    gasConfig?: import('./treasury-graph.js').TreasuryGraphDeps['gasConfig'];
    gasRoute?: import('./treasury-graph.js').TreasuryGraphDeps['gasRoute'];
  } {
    const registry = this.deps.chainRegistry;
    if (!registry || !registry.has(agent.chainId)) return {};
    const chainConfig = registry.getChainConfig(agent.chainId);
    const globalDustWei = this.deps.settings.globalDustWei ?? 2_000_000_000_000_000n; // 0.002 0G
    // AQ-FND M-3 inc-2: the multi-chain survey inputs, re-read every cycle by the graph
    // (deployments can change while the agent runs).
    const gasRoute: NonNullable<import('./treasury-graph.js').TreasuryGraphDeps['gasRoute']> = {
      resolveChain: (chainId) => registry.getSessionChain(chainId),
      chainName: (chainId) => (registry.has(chainId) ? registry.getChainConfig(chainId).name : `chain ${chainId}`),
      chainConfigOf: (chainId) => registry.getChainConfig(chainId),
      load: (homeGoalToken) =>
        loadGasRouteInputs({
          pool: this.deps.pool,
          registry,
          agentId: agent.id,
          homeChainId: agent.chainId,
          goalToken: homeGoalToken,
          globalDustWei,
          cctpFillEnabled: this.deps.settings.cctpFillEnabled === true,
        }),
    };
    return {
      gasConfig: { chainConfig, globalDustWei },
      gasRoute,
    };
  }

  /** A job role cannot run without the 0G Storage uploader (deliverable/PoA sink). */
  private requireUploader(): StorageUploader {
    if (!this.deps.uploader) throw new Error('job role requires a StorageUploader (uploader dep missing)');
    return this.deps.uploader;
  }

  async start(agentId: string, opts: { resume?: boolean } = {}): Promise<void> {
    if (this.deps.lease && !this.deps.lease.held()) throw new RuntimeLeaseNotHeldError();
    if (this.draining) throw new Error('the runtime is shutting down; not starting new agent loops');
    if (this.loops.has(agentId)) return;
    const agent = await getAgentById(this.deps.pool, agentId);
    if (!agent || agent.status !== 'active') throw new Error('agent not startable');
    // SF-2 (F-2b): an external bound agent has no session key → no runnable
    // loop. It should never reach here (POST /start rejects it + listActiveAgents
    // excludes it), but assert loudly so a leak fails closed, not with a silent
    // null session key decrypt.
    assertNativeAgent(agent);
    if (!agent.gatewayTokenEnc) throw new Error('agent has no runtime gateway token');
    const { keyring } = this.deps.settings;
    const ctx = {
      agentId: agent.id,
      accountAddr: agent.accountAddr,
      goal: agent.goal,
      agentRow: agent,
      sessionPrivateKey: decryptSecret(agent.sessionKeyEnc, keyring),
      gatewayToken: decryptSecret(agent.gatewayTokenEnc, keyring),
    };
    // Phase-4 dispatch (spec §3b): the ACP job roles run in their OWN graph
    // (jobs/graph.ts); every legacy role stays on the treasury/transfer graph.
    const role = goalRole(agent.goal);
    const isJobRole = role === 'requester' || role === 'provider' || role === 'evaluator';
    const graph: TreasuryGraph | JobGraph = isJobRole
      ? buildJobGraph(
          {
            pool: this.deps.pool,
            hub: this.deps.hub,
            chain: this.deps.resolveChain?.(agent.chainId) ?? this.deps.chain,
            uploader: this.requireUploader(),
            gatewayUrl: this.deps.settings.gatewayUrl,
            defaultModel: this.deps.settings.defaultModel,
            providerModel: this.deps.settings.jobProviderModel ?? this.deps.settings.defaultModel,
            evaluatorModel: this.deps.settings.jobEvaluatorModel ?? this.deps.settings.defaultModel,
            getCoordinator: () => this.coordinator,
            alerts: this.deps.alerts,
            approvalTimeoutMs: this.deps.settings.approvalTimeoutMs,
            ...(this.deps.settings.fetchFn ? { fetchFn: this.deps.settings.fetchFn } : {}),
          },
          ctx,
          this.deps.checkpointer,
        )
      : buildTreasuryGraph(
          {
            pool: this.deps.pool,
            hub: this.deps.hub,
            chain: this.deps.resolveChain?.(agent.chainId) ?? this.deps.chain,
            gatewayUrl: this.deps.settings.gatewayUrl,
            defaultModel: this.deps.settings.defaultModel,
            getCoordinator: () => this.coordinator,
            alerts: this.deps.alerts,
            boundaries: this.boundaries,
            approvalTimeoutMs: this.deps.settings.approvalTimeoutMs,
            // Stage D (D-8/D-10): the L2 JIT rail for a novel governed call. Only
            // wired when the alert engine is present (raiseCapabilityRequest needs
            // it); a coordination-free/alert-free test setup then stands down on
            // novelty instead.
            ...(this.capabilityDeps() ? { capabilities: this.capabilityDeps() } : {}),
            // SF-3: the governed tool-use rail (optional; absent ⇒ tool_call stands down).
            ...(this.toolRailDeps() ? { toolRail: this.toolRailDeps() } : {}),
            // FP-3: the governed signing rail (optional; absent ⇒ sign stands down).
            ...(this.signingRailDeps() ? { signingRail: this.signingRailDeps() } : {}),
            // SE-8: the governed-bridging lane — only when the registry knows the
            // agent's chain AND that chain has an owner-configured bridge allowlist.
            // Absent = fail-closed (a bridge call classifies forbidden / stands down).
            ...(this.bridgeDeps(agent) ?? {}),
            // AQ-FND M-3: the self-funding gas ladder (config + rung-4 executor). Absent
            // ⇒ token top-up acts as the native path (no regression).
            ...this.gasDeps(agent),
            ...(this.deps.settings.fetchFn ? { fetchFn: this.deps.settings.fetchFn } : {}),
          },
          ctx,
          this.deps.checkpointer,
        );
    const loop: Loop = { stopped: false, timer: null, current: Promise.resolve(), busy: false, consecutiveFailures: 0, pendingApprovalId: null, graph, agent, gatewayToken: ctx.gatewayToken };
    this.loops.set(agentId, loop);
    await this.setDesired(agentId, true); // AQ-FND S1: a restart resumes exactly what the owner started
    // An OWNER start/resume gets a fresh failure budget (the cause was presumably fixed); a boot-time
    // resume must NOT, or a flapping agent would reset its own counters on every restart.
    if (!opts.resume) await resetBreakers(this.deps.pool, agentId).catch(() => undefined);
    this.schedule(loop, 0);
  }

  async stop(agentId: string): Promise<void> {
    await this.halt(agentId, 'agent stopped by owner');
  }

  isRunning(agentId: string): boolean {
    return this.loops.has(agentId);
  }

  /** AQ-FND S1: persist whether the OWNER wants this agent running (survives restarts). Best-effort, never throws. */
  private async setDesired(agentId: string, desired: boolean): Promise<void> {
    try {
      await this.deps.pool.query(`UPDATE agents SET run_desired = $2 WHERE id = $1 AND run_desired IS DISTINCT FROM $2`, [agentId, desired]);
    } catch (err) {
      console.error(`failed to persist run_desired=${desired} for agent ${agentId}`, err);
    }
  }

  /**
   * AQ-FND S1 (review blocker B-2): after a (re)start, resume every agent the owner left running.
   * Staggered so a fleet does not stampede the RPC/LLM on boot. A failure to resume one agent is
   * traced and never blocks the others. Owner-stopped / breaker-paused / revoked agents stay stopped.
   */
  async resumeDesired(opts: { staggerMs?: number } = {}): Promise<number> {
    const stagger = opts.staggerMs ?? 250;
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `SELECT id FROM agents WHERE status = 'active' AND run_desired AND bind_mode IS DISTINCT FROM 'external' ORDER BY created_at`,
    );
    let started = 0;
    for (const { id } of rows) {
      if (this.draining) break;
      try {
        await this.start(id, { resume: true });
        started++;
        const rec = await appendTrace(this.deps.pool, { agentId: id, kind: 'decision', detail: { summary: 'resumed after a LEASH restart (you had it running)' } });
        this.deps.hub.emit(id, 'trace', traceEvent(rec));
      } catch (err) {
        console.error(`could not resume agent ${id} after restart`, err);
      }
      if (stagger > 0) await new Promise((r) => setTimeout(r, stagger));
    }
    return started;
  }

  /**
   * AQ-FND S1: graceful shutdown. Stop scheduling NEW cycles, let in-flight cycles finish (bounded),
   * and leave `run_desired` untouched so the next boot resumes the same agents. A cycle waiting on a
   * human approval is not waited for (and is NOT denied): its approval row stays pending.
   * Anything still mid-send is safe: the intent ledger persisted it before broadcast.
   */
  async drain(timeoutMs = 30_000): Promise<void> {
    this.draining = true;
    const pending: Promise<unknown>[] = [];
    for (const loop of this.loops.values()) {
      loop.stopped = true;
      if (loop.timer) clearTimeout(loop.timer);
      loop.timer = null;
      if (loop.busy && !loop.pendingApprovalId) pending.push(loop.current.catch(() => undefined));
    }
    await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, timeoutMs).unref())]);
    this.loops.clear();
  }

  async haltForRevoke(agentId: string): Promise<void> {
    await this.halt(agentId, 'agent revoked');
  }

  /** Deliver an owner decision to a paused run (same rendezvous the API uses). */
  resume(approvalId: string, decision: ApprovalDecision): boolean {
    return this.deps.broker.notify(approvalId, decision);
  }

  /**
   * SE-2 (SD-E2): after the owner picks approve_once (and client-side signs
   * `authorizeOnce(callHash)`), auto-retry the originally-refused call and consume
   * the on-chain one-shot exactly once. Fire-and-forget from the owner route (the
   * on-chain submit must not block the HTTP response); errors are traced by
   * consumeOneShot / recordFailure, never thrown to the caller. The agent must be
   * active (its scoped session key is the only signing material that can retry).
   */
  async consumeApprovedOneShot(agentId: string, requestId: string): Promise<void> {
    try {
      const agent = await getAgentById(this.deps.pool, agentId);
      if (!agent || agent.status !== 'active') return; // not actable — stand down silently
      assertNativeAgent(agent); // SF-2: a bound agent has no one-shot/session key to consume
      const ctx = {
        agentId: agent.id,
        accountAddr: agent.accountAddr,
        sessionPrivateKey: decryptSecret(agent.sessionKeyEnc, this.deps.settings.keyring),
      };
      // SE-7 (carry #2): the consume submits on the AGENT'S chain — resolved
      // per chainId via the registry when wired, defaulting to the single chain.
      const chain = this.deps.resolveChain?.(agent.chainId) ?? this.deps.chain;
      // SE-8: the bridge one-shot rail — same-address pre-routing gate (E-12 fix).
      const registry = this.deps.chainRegistry;
      const deps = {
        pool: this.deps.pool,
        hub: this.deps.hub,
        chain,
        ...(registry
          ? {
              bridgeGuard: (bridgeTarget: string, decoded?: import('../governed-call/types.js').DecodedCall) =>
                assertBridgeRoutable(registry, agent, bridgeTarget, decoded),
              // E-13 sec M-01: the rail keys on bridge-allowlisted TARGETS too.
              bridgeTargets: new Set(
                (registry.has(agent.chainId) ? (registry.getChainConfig(agent.chainId).bridgeAllowlist ?? []) : []).map(
                  (a) => a.toLowerCase(),
                ),
              ),
            }
          : {}),
      };
      // The decision carries the authorizeOnce txHash, but a client may report it
      // optimistically before it mines — the first consume then sees the one-shot
      // not-yet-live and stands down `retryable` (the request stays re-claimable).
      // Bounded backoff catches that confirmation latency; a genuinely-gone
      // one-shot just exhausts the retries (the on-chain wall guards regardless).
      for (let attempt = 0; attempt < ONE_SHOT_CONSUME_MAX_ATTEMPTS; attempt++) {
        const outcome = await consumeOneShot(deps, ctx, requestId);
        if (outcome.type !== 'stood_down' || !outcome.retryable) return;
        if (attempt < ONE_SHOT_CONSUME_MAX_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, ONE_SHOT_CONSUME_RETRY_MS).unref?.());
        }
      }
    } catch (err) {
      await this.recordFailure(agentId, err);
    }
  }

  /**
   * FP-3 (L2 consent → arm): after the owner APPROVES a sensitive signing request (approve_once /
   * always_allow), submit the on-chain arm via the agent's scoped session key using the server-held
   * intent (fields + digest quarantined at raise time) and record it in `signing_arms`. The symmetric
   * analogue of `consumeApprovedOneShot` for the signing rail. Fire-and-forget (never blocks the HTTP
   * response); the on-chain wall re-validates + debits regardless (a revert = traced failure, never a
   * phantom arm). Idempotent against a re-trigger: a still-live digest reverts `AlreadyArmed` → traced.
   */
  async armApprovedSigning(agentId: string, requestId: string): Promise<void> {
    try {
      const agent = await getAgentById(this.deps.pool, agentId);
      if (!agent || agent.status !== 'active') return;
      assertNativeAgent(agent);
      const chain = this.deps.resolveChain?.(agent.chainId) ?? this.deps.chain;
      if (!chain.authorizeSigningIntent) return; // runtime chain cannot arm (e.g. a read-only fake)
      const request = await getSigningRequest(this.deps.pool, requestId);
      if (!request || request.agentId !== agent.id) return;
      if (request.status !== 'approved_once' && request.status !== 'always_allowed') return;
      const intent = request.intent as { descriptorId?: number; fields?: string[]; digest?: string; caps?: { token: string; cap: string }[] } | null;
      if (!intent || intent.descriptorId === undefined || !intent.fields || !intent.digest) return;
      const sessionPrivateKey = decryptSecret(agent.sessionKeyEnc, this.deps.settings.keyring);
      const armed = await chain.authorizeSigningIntent({
        sessionPrivateKey,
        accountAddr: agent.accountAddr,
        descriptorId: intent.descriptorId,
        fields: intent.fields,
        digest: intent.digest,
        send: { agentId: agent.id, idemKey: `${agent.id}:sign-arm:${requestId}`, payload: { descriptorId: intent.descriptorId, digest: intent.digest, requestId } },
        // batch arms submit the reviewed caps; non-batch intents omit it (the arm defaults to `[]`).
        ...(intent.caps ? { caps: intent.caps } : {}),
      });
      const decoded = request.decoded as Record<string, unknown>;
      await recordSigningArm(this.deps.pool, {
        agentId: agent.id,
        descriptorId: intent.descriptorId,
        digest: armed.digest,
        spender: typeof decoded['spender'] === 'string' ? decoded['spender'] : '',
        amount: typeof decoded['amountWei'] === 'string' ? decoded['amountWei'] : '0',
        deadline: typeof decoded['deadlineSec'] === 'number' ? decoded['deadlineSec'] : 0,
        epoch: armed.epoch,
      });
    } catch (err) {
      await this.recordFailure(agentId, err);
    }
  }

  /**
   * L-01 (SE-5.0): crash-durability for the fire-and-forget one-shot retry.
   * `consumeApprovedOneShot` is an in-memory trigger — a backend restart mid-retry
   * drops the consume (request stays `approved_once`, consume_status NULL|aborted).
   * This periodic sweep re-drives every resumable one-shot still within the one-
   * shot TTL, so a crash never silently strands an owner-authorized approve-once.
   * Idempotent against the live trigger: the CAS in claimOneShotConsumption means a
   * row already `consuming` (in-flight) is skipped, and a `consumed`/`failed` row is
   * excluded by the query — so a swept row can only consume the exact one time.
   * Runs on boot + on a timer (index.ts), mirroring the reservation/approval sweeps.
   *
   * SE-7 (carry #2, RESOLVED): the sweep re-drives through `consumeApprovedOneShot`,
   * which now resolves the AGENT'S chain client via `deps.resolveChain(agent.chainId)`
   * (ChainRegistry.getSessionChain in production) — a chain-B one-shot can no longer
   * be re-driven against chain-A's client.
   */
  async sweepResumableOneShots(): Promise<number> {
    const ttlMs = this.deps.settings.jitTtlMs ?? 600_000;
    const resumable = await listResumableOneShots(this.deps.pool, ttlMs);
    for (const { id, agentId } of resumable) {
      await this.consumeApprovedOneShot(agentId, id);
    }
    return resumable.length;
  }

  /**
   * Delivery-latency nudge (spec §3b): an activated delegation wakes the
   * receiver's loop NOW instead of on the next poll. Optimization ONLY — the
   * poll remains the correctness path, so every miss (no loop, stopped, cycle
   * in flight) is a safe no-op. Race-safety: while a cycle is in flight
   * (`busy`) we must not schedule — runCycle's finally() already re-schedules
   * and a second timer would double-run the loop; when idle, the only pending
   * timer is ours to replace.
   */
  nudge(agentId: string): void {
    const loop = this.loops.get(agentId);
    if (!loop || loop.stopped || loop.busy) return;
    if (loop.timer) clearTimeout(loop.timer);
    this.schedule(loop, 0);
  }

  /** Await the in-flight cycle (tests + graceful shutdown). */
  async settle(agentId: string): Promise<void> {
    await this.loops.get(agentId)?.current;
  }

  private async halt(agentId: string, reason: string): Promise<void> {
    const loop = this.loops.get(agentId);
    // Owner stop / revoke / no-longer-active: the agent must NOT come back on the next boot.
    await this.setDesired(agentId, false);
    if (!loop) return;
    loop.stopped = true;
    if (loop.timer) clearTimeout(loop.timer);
    loop.timer = null;
    // Wake a paused run so the cycle finishes fail-closed instead of dangling.
    if (loop.pendingApprovalId) {
      this.deps.broker.notify(loop.pendingApprovalId, { decision: 'deny', reason });
    }
    this.loops.delete(agentId);
    await loop.current;
  }

  private schedule(loop: Loop, delayMs: number): void {
    if (loop.stopped) return;
    loop.timer = setTimeout(() => {
      loop.busy = true;
      loop.current = this.runCycle(loop)
        .then(() => {
          loop.consecutiveFailures = 0;
        })
        .catch(async (err: unknown) => {
          // A cycle that died because the loop was stopped under it is not the agent's fault.
          if (!loop.stopped) loop.consecutiveFailures += 1;
          const budget = this.deps.settings.failureBudget ?? DEFAULT_FAILURE_BUDGET;
          await this.recordFailure(loop.agent.id, err, !budgetExhausted(loop.consecutiveFailures, budget));
          await this.tripBreakerIfExhausted(loop, err);
          // AQ-FND S1: also count it in the typed, persisted budget (survives restarts).
          if (!loop.stopped) await this.recordBudget(loop, classifyThrown(err), describeCycleFailure(err, { retrying: false }));
        })
        .finally(() => {
          loop.busy = false;
          const { intervalMs, maxBackoffMs } = this.deps.settings;
          this.schedule(loop, nextCycleDelayMs(intervalMs, loop.consecutiveFailures, maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS));
        });
    }, delayMs);
    loop.timer.unref();
  }

  private async runCycle(loop: Loop): Promise<void> {
    // Fail-closed per cycle: never run against a revoked/deleted row.
    // INVARIANT (Phase-5.5): `ctx.goal` is owned solely by the `sense_direction`
    // head node — it is deliberately NOT refreshed from `fresh.goal` here. The
    // only writer of agents.goal is sense_direction (via a confirmed directive),
    // which mutates the in-memory ctx.goal alongside the DB write. Any FUTURE
    // goal-writer MUST go through the cycle-boundary apply, not a direct
    // agents.goal write, or a running loop would use a stale in-memory goal.
    const fresh = await getAgentById(this.deps.pool, loop.agent.id);
    if (loop.stopped) return;
    if (!fresh || fresh.status !== 'active') {
      await this.halt(loop.agent.id, 'agent no longer active');
      return;
    }
    // Inbound-delegation input channel (spec §3b): this cycle consumes at most
    // ONE activated envelope addressed to this agent, as sensed input.
    const inbound = await this.pickUpInbound(loop.agent.id);
    const cycleId = randomUUID();
    const config = { configurable: { thread_id: `${loop.agent.id}:${cycleId}` } };
    // AQ-FND S1: the cycle id scopes every send's idempotency key (a re-executed node can never double-send).
    await loop.graph.invoke(inbound ? { inboundDelegation: inbound, cycleId } : { cycleId }, config);

    const snapshot = await loop.graph.getState(config);
    // 0.2.x: pending interrupts live on tasks[].interrupts, NOT result.__interrupt__ (PHASE-0 §1b).
    const pending = snapshot.tasks.flatMap((t) => t.interrupts)[0];
    if (!pending) await this.recordCycleBudget(loop, snapshot.values);
    if (!pending) {
      // Cycle completed without an approval interrupt — the directed origin's
      // output is ready; propose the chain's first hop (Phase 5.6).
      await this.maybeAdvanceChains(loop, config);
      return;
    }
    const { approvalId } = pending.value as { approvalId: string };

    loop.pendingApprovalId = approvalId;
    let decision = await this.awaitDecision(approvalId);
    loop.pendingApprovalId = null;

    // The owner-decision consent record is appended by POST /api/approvals/:id
    // at decision time, strictly before the broker notify — so it is durable
    // before this run resumes (spec §3b: consent-seq < action-seq). This path
    // appends only the TIMEOUT consent: pending → expired, chain-visible.
    if (decision === 'timeout') {
      const expired = await expireApproval(this.deps.pool, approvalId);
      if (expired) {
        const consent = await appendTrace(this.deps.pool, {
          agentId: loop.agent.id,
          kind: 'consent',
          approvalId,
          decision: 'expired',
          decidedBy: 'system',
          originalRequest: expired.requestRef,
          detail: { reason: 'approval timed out' },
        });
        this.deps.hub.emit(loop.agent.id, 'trace', traceEvent(consent));
        await this.deps.alerts?.resolveByApproval(approvalId, {
          resolution: 'expired',
          via: 'system',
          agentId: loop.agent.id,
          consentSeq: consent.seq,
        });
      } else {
        // decided at the buzzer — pick the durable decision up instead
        decision = (await decidedInDb(this.deps.pool, approvalId)) ?? 'timeout';
      }
    }
    const resolved: ApprovalDecision =
      decision === 'timeout' ? { decision: 'deny', reason: 'approval timed out' } : decision;
    await loop.graph.invoke(new Command({ resume: resolved }), config);
    await this.recordCycleBudget(loop, (await loop.graph.getState(config)).values);
    await this.maybeAdvanceChains(loop, config);
  }

  /**
   * Phase 5.6 runtime hook (spec §3b — the ONLY new runtime behavior): after a
   * DIRECTED agent completes a cycle, if it originates an owner-confirmed chain
   * plan with an un-proposed FIRST hop, propose that hop carrying this cycle's
   * output as labeled-untrusted upstreamOutput. Owner-plan-gated (never invents
   * a hop or a target), rides the cycle boundary, idempotent (the CAS in the
   * chains projection makes a hop proposed exactly once). Only hop 0 is kicked
   * here — every later hop advances via onHopSettled when the prior hop settles.
   */
  private async maybeAdvanceChains(
    loop: Loop,
    config: { configurable: { thread_id: string } },
  ): Promise<void> {
    if (!this.coordinator) return;
    const agentId = loop.agent.id;
    const chains = (await listAdvancingChainsForOrigin(this.deps.pool, agentId)).filter((c) => c.nextHop === 0);
    if (chains.length === 0) return;
    const snapshot = await loop.graph.getState(config);
    const values = (snapshot.values ?? {}) as Record<string, unknown>;
    const rawReasoning = values['reasoning'];
    const reasoning = typeof rawReasoning === 'string' ? rawReasoning.slice(0, 2000) : '';
    const upstreamOutput = { outcome: (values['outcome'] as Json) ?? null, reasoning } as unknown as Json;
    const chainDeps: ChainDeps = {
      pool: this.deps.pool,
      hub: this.deps.hub,
      coordinator: this.coordinator,
      config: this.deps.settings.chainConfig ?? DEFAULT_CHAIN_CONFIG,
    };
    for (const c of chains) {
      const hop0 = c.plan[0];
      // Option-C (S25): a MULTI-member hop gets a model-driven pick (isolated
      // gateway selector); the emitted id is UNTRUSTED → proposeNextHop's BC-2
      // re-validates it ∈ eligibleTargetIds (an off-set emit HARD-terminates the
      // chain). A one-member hop, or a failed/garbled selection, falls back to
      // deterministic in-set selection.
      let selection: HopSelection = { auto: true };
      if (hop0 && hop0.eligibleTargetIds.length > 1) {
        const emitted = await selectHopTargetViaGateway(
          {
            gatewayUrl: this.deps.settings.gatewayUrl,
            gatewayToken: loop.gatewayToken,
            model: this.deps.settings.defaultModel,
            ...(this.deps.settings.fetchFn ? { fetchFn: this.deps.settings.fetchFn } : {}),
          },
          { eligibleTargetIds: hop0.eligibleTargetIds, directedIntent: hop0.directedIntent, upstreamOutput },
        );
        if (emitted !== undefined) selection = { emitted };
      }
      await proposeNextHop(chainDeps, c.id, upstreamOutput, selection);
    }
  }

  /**
   * Fetch ONE activatable pending delegation (FIFO; expiry refused at the
   * pickup query — point A of three, spec §3b) and accept it BEFORE reasoning:
   * markAccepted is the single serialized transition writer, so a second
   * racing cycle gets null and skips — double-processing is impossible.
   */
  private async pickUpInbound(agentId: string): Promise<InboundDelegationInput | null> {
    const coordinator = this.coordinator;
    if (!coordinator) return null;
    // P3C-4: envelopes whose link went inactive die HERE, chain-visibly —
    // and the pickup query itself only returns active-link rows.
    await coordinator.cancelInactiveLinkPickups(agentId);
    const [candidate] = await listActivatablePendingFor(this.deps.pool, agentId, 1);
    if (!candidate) return null;
    const accepted = await coordinator.markAccepted(candidate.id);
    if (!accepted) return null; // raced — another writer settled the row first
    return {
      delegationId: accepted.id,
      kind: accepted.kind,
      payload: accepted.payload,
      fromAgentId: accepted.fromAgentId,
    };
  }

  /** C-3: the SHARED register→check→wait→recheck rendezvous (approvals/rendezvous.ts). */
  private async awaitDecision(approvalId: string): Promise<ApprovalDecision | 'timeout'> {
    return awaitApprovalDecision(
      { pool: this.deps.pool, broker: this.deps.broker },
      approvalId,
      this.deps.settings.approvalTimeoutMs,
    );
  }

  /**
   * E1 loop-breaker. After the failure budget of consecutive failed cycles the agent PAUSES ITSELF
   * (same effect as the cockpit's Pause: the runtime loop stops, the DB row stays `active`), leaves
   * one trace row and one owner alert, and a later Resume starts it with a fresh budget. Runs inside
   * the loop's own `current` promise, so it must NOT await it (halt() would deadlock) — it just marks
   * the loop stopped and drops it, and schedule() then no-ops.
   */
  /** AQ-FND S1: classify the finished cycle and feed the typed, persisted failure budget. */
  private async recordCycleBudget(loop: Loop, values: unknown): Promise<void> {
    const v = (values ?? {}) as { outcome?: { type: string; reason?: string; decoded?: unknown }; finishReason?: string | null };
    const cls = classifyCycleResult({ outcome: v.outcome, finishReason: v.finishReason ?? null, parseMissReason: PARSE_MISS_REASON });
    await this.recordBudget(loop, cls, v.outcome?.reason ?? '');
  }

  private async recordBudget(loop: Loop, cls: FailureClass | null, detail: string): Promise<void> {
    if (loop.stopped) return;
    // failureBudget 0 is the documented kill switch for loop-breaking (retry forever): honour it here too.
    if ((this.deps.settings.failureBudget ?? DEFAULT_FAILURE_BUDGET) === 0) return;
    try {
      const r = await recordCycleResult(this.deps.pool, loop.agent.id, cls, detail);
      if (r.tripped) await this.pauseForBreaker(loop, `paused: ${describeTrip(r.tripped, r.count, detail)}`, detail);
    } catch (err) {
      console.error(`failed to record the failure budget for agent ${loop.agent.id}`, err);
    }
  }

  /** Pause an agent because a breaker tripped: stop the loop, forget the desire to run, trace + alert in plain words. */
  private async pauseForBreaker(loop: Loop, summary: string, raw: unknown): Promise<void> {
    const agentId = loop.agent.id;
    loop.stopped = true;
    if (loop.timer) clearTimeout(loop.timer);
    loop.timer = null;
    this.loops.delete(agentId);
    await this.setDesired(agentId, false); // a crash-looping agent must not auto-restart
    console.error(`[loop-breaker] agent ${agentId} ${summary}`);
    try {
      const rec = await appendTrace(this.deps.pool, { agentId, kind: 'decision', detail: { summary, rawError: rawErrorText(raw) } });
      this.deps.hub.emit(agentId, 'trace', traceEvent(rec));
      if (this.deps.alerts) {
        await this.deps.alerts.emit(loop.agent.ownerAddr, {
          agentId,
          class: 'info',
          kind: 'runtime_error',
          summary: `${loop.agent.name} ${summary}. Fix the cause, then press Resume.`,
          refs: { traceSeq: rec.seq },
          dedupKey: `breaker:${agentId}`,
        });
      }
    } catch (traceErr) {
      console.error(`failed to record loop-breaker pause for agent ${agentId}`, traceErr);
    }
  }

  private async tripBreakerIfExhausted(loop: Loop, err: unknown): Promise<void> {
    const budget = this.deps.settings.failureBudget ?? DEFAULT_FAILURE_BUDGET;
    if (loop.stopped || !budgetExhausted(loop.consecutiveFailures, budget)) return;
    const agentId = loop.agent.id;
    loop.stopped = true;
    if (loop.timer) clearTimeout(loop.timer);
    loop.timer = null;
    this.loops.delete(agentId);
    await this.setDesired(agentId, false); // a crash-looping agent must not auto-restart
    const summary = `paused after ${loop.consecutiveFailures} consecutive failed cycles — last error: ${describeCycleFailure(err, { retrying: false })}`;
    console.error(`[loop-breaker] agent ${agentId} ${summary}`);
    try {
      const rec = await appendTrace(this.deps.pool, { agentId, kind: 'decision', detail: { summary, rawError: rawErrorText(err) } });
      this.deps.hub.emit(agentId, 'trace', traceEvent(rec));
      if (this.deps.alerts) {
        await this.deps.alerts.emit(loop.agent.ownerAddr, {
          agentId,
          class: 'info',
          kind: 'runtime_error',
          summary: `${loop.agent.name} paused itself: ${summary}. Fix the cause, then press Resume.`,
          refs: { traceSeq: rec.seq },
          dedupKey: `breaker:${agentId}`,
        });
      }
    } catch (traceErr) {
      console.error(`failed to record loop-breaker pause for agent ${agentId}`, traceErr);
    }
  }

  private async recordFailure(agentId: string, err: unknown, retrying = true): Promise<void> {
    const plain = describeCycleFailure(err, { retrying });
    console.error(`runtime cycle failed for agent ${agentId}`, err);
    try {
      const rec = await appendTrace(this.deps.pool, {
        agentId,
        kind: 'decision',
        detail: { summary: `cycle failed: ${plain}`, rawError: rawErrorText(err) },
      });
      this.deps.hub.emit(agentId, 'trace', traceEvent(rec));
      // Daily loop: repeated cycle errors coalesce into ONE alert per
      // (agent, hour bucket) — count increments, no chore queue (spec §3b).
      const agent = this.loops.get(agentId)?.agent ?? (await getAgentById(this.deps.pool, agentId));
      if (agent && this.deps.alerts) {
        const hourBucket = new Date().toISOString().slice(0, 13);
        // L-02 (security gate): the alert carries only the plain one-liner; the full runtime-influenced
        // error text stays on the trace record (`rawError`).
        await this.deps.alerts.emit(agent.ownerAddr, {
          agentId,
          class: 'info',
          kind: 'runtime_error',
          summary: `${agent.name} hit a runtime error: ${plain}`,
          refs: { traceSeq: rec.seq },
          dedupKey: `runtime_error:${agentId}:${hourBucket}`,
        });
      }
    } catch (traceErr) {
      console.error(`failed to record runtime failure for agent ${agentId}`, traceErr);
    }
  }
}
