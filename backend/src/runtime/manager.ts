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
import { decryptSecret } from '../crypto/keycrypt.js';
import { appendTrace } from '../trace/trace-store.js';
import { traceEvent } from '../sse/events.js';
import type { AgentRow } from '../types.js';
import { goalRole } from '../types.js';
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
import type { ChainRegistry } from '../chain/registry.js';
import { assertBridgeRoutable } from './bridge-gate.js';
import { buildTreasuryGraph, type TreasuryGraph } from './treasury-graph.js';
import { consumeOneShot } from './one-shot-consume.js';
import type { CapabilityDeps } from '../capabilities/service.js';
import { defaultToolRegistry } from '../tool-use/index.js';
import { createDbGrantLoader } from '../gateway/mcp/governed-provider.js';
import { createHttpMcpEgressClient, parseEgressConfigFromEnv } from '../gateway/mcp/egress.js';
import { buildJobGraph, type JobGraph } from '../jobs/graph.js';
import type { StorageUploader } from '../audit/batcher.js';
import type { InboundDelegationInput } from './prompt.js';

/** SE-2: bounded backoff so a slightly-late authorizeOnce still gets consumed. */
const ONE_SHOT_CONSUME_MAX_ATTEMPTS = 6;
const ONE_SHOT_CONSUME_RETRY_MS = 2_000;

export interface RuntimeSettings {
  keyEncryptionSecret: string;
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
    };
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
        assertRoutable: (bridgeTarget: string) => assertBridgeRoutable(registry, agent, bridgeTarget),
      },
    };
  }

  /** A job role cannot run without the 0G Storage uploader (deliverable/PoA sink). */
  private requireUploader(): StorageUploader {
    if (!this.deps.uploader) throw new Error('job role requires a StorageUploader (uploader dep missing)');
    return this.deps.uploader;
  }

  async start(agentId: string): Promise<void> {
    if (this.deps.lease && !this.deps.lease.held()) throw new RuntimeLeaseNotHeldError();
    if (this.loops.has(agentId)) return;
    const agent = await getAgentById(this.deps.pool, agentId);
    if (!agent || agent.status !== 'active') throw new Error('agent not startable');
    if (!agent.gatewayTokenEnc) throw new Error('agent has no runtime gateway token');
    const { keyEncryptionSecret } = this.deps.settings;
    const ctx = {
      agentId: agent.id,
      accountAddr: agent.accountAddr,
      goal: agent.goal,
      agentRow: agent,
      sessionPrivateKey: decryptSecret(agent.sessionKeyEnc, keyEncryptionSecret),
      gatewayToken: decryptSecret(agent.gatewayTokenEnc, keyEncryptionSecret),
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
            // SE-8: the governed-bridging lane — only when the registry knows the
            // agent's chain AND that chain has an owner-configured bridge allowlist.
            // Absent = fail-closed (a bridge call classifies forbidden / stands down).
            ...(this.bridgeDeps(agent) ?? {}),
            ...(this.deps.settings.fetchFn ? { fetchFn: this.deps.settings.fetchFn } : {}),
          },
          ctx,
          this.deps.checkpointer,
        );
    const loop: Loop = { stopped: false, timer: null, current: Promise.resolve(), busy: false, pendingApprovalId: null, graph, agent, gatewayToken: ctx.gatewayToken };
    this.loops.set(agentId, loop);
    this.schedule(loop, 0);
  }

  async stop(agentId: string): Promise<void> {
    await this.halt(agentId, 'agent stopped by owner');
  }

  isRunning(agentId: string): boolean {
    return this.loops.has(agentId);
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
      const ctx = {
        agentId: agent.id,
        accountAddr: agent.accountAddr,
        sessionPrivateKey: decryptSecret(agent.sessionKeyEnc, this.deps.settings.keyEncryptionSecret),
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
              bridgeGuard: (bridgeTarget: string) => assertBridgeRoutable(registry, agent, bridgeTarget),
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
        .catch(async (err: unknown) => this.recordFailure(loop.agent.id, err))
        .finally(() => {
          loop.busy = false;
          this.schedule(loop, this.deps.settings.intervalMs);
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
    const config = { configurable: { thread_id: `${loop.agent.id}:${randomUUID()}` } };
    await loop.graph.invoke(inbound ? { inboundDelegation: inbound } : {}, config);

    const snapshot = await loop.graph.getState(config);
    // 0.2.x: pending interrupts live on tasks[].interrupts, NOT result.__interrupt__ (PHASE-0 §1b).
    const pending = snapshot.tasks.flatMap((t) => t.interrupts)[0];
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

  private async recordFailure(agentId: string, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`runtime cycle failed for agent ${agentId}`, err);
    try {
      const rec = await appendTrace(this.deps.pool, {
        agentId,
        kind: 'decision',
        detail: { summary: `cycle failed: ${message}` },
      });
      this.deps.hub.emit(agentId, 'trace', traceEvent(rec));
      // Daily loop: repeated cycle errors coalesce into ONE alert per
      // (agent, hour bucket) — count increments, no chore queue (spec §3b).
      const agent = this.loops.get(agentId)?.agent ?? (await getAgentById(this.deps.pool, agentId));
      if (agent && this.deps.alerts) {
        const hourBucket = new Date().toISOString().slice(0, 13);
        // L-02 (security gate): third-party error text is unbounded and
        // runtime-influenced — truncate before it reaches any notification
        // surface (the full message stays on the trace record).
        const brief = message.length > 200 ? `${message.slice(0, 197)}...` : message;
        await this.deps.alerts.emit(agent.ownerAddr, {
          agentId,
          class: 'info',
          kind: 'runtime_error',
          summary: `${agent.name} hit a runtime error: ${brief}`,
          refs: { traceSeq: rec.seq },
          dedupKey: `runtime_error:${agentId}:${hourBucket}`,
        });
      }
    } catch (traceErr) {
      console.error(`failed to record runtime failure for agent ${agentId}`, traceErr);
    }
  }
}
