import { randomUUID } from 'node:crypto';
import { Command, type BaseCheckpointSaver } from '@langchain/langgraph';
import type { Pool } from 'pg';
import type { RuntimeManager } from '../server.js';
import type { SseHub } from '../sse/hub.js';
import type { ApprovalBroker, ApprovalDecision } from '../approvals/broker.js';
import { getAgentById } from '../store/agents.js';
import { expireApproval } from '../store/approvals.js';
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
import type { RuntimeChain } from './session-chain.js';
import { buildTreasuryGraph, type TreasuryGraph } from './treasury-graph.js';
import { buildJobGraph, type JobGraph } from '../jobs/graph.js';
import type { StorageUploader } from '../audit/batcher.js';
import type { InboundDelegationInput } from './prompt.js';

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
  fetchFn?: typeof fetch;
}

export interface RuntimeManagerDeps {
  pool: Pool;
  hub: SseHub;
  broker: ApprovalBroker;
  chain: RuntimeChain;
  checkpointer: BaseCheckpointSaver;
  /** Phase-3 alert engine (optional in coordination-free test setups). */
  alerts?: AlertService | undefined;
  /**
   * Phase-4: 0G Storage Log Layer uploader — the provider/evaluator job graphs
   * write the deliverable + rationale here (ECIES owner-only). Absent only in
   * treasury-only test setups (the job graph is never built then).
   */
  uploader?: StorageUploader | undefined;
  settings: RuntimeSettings;
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

  /** A job role cannot run without the 0G Storage uploader (deliverable/PoA sink). */
  private requireUploader(): StorageUploader {
    if (!this.deps.uploader) throw new Error('job role requires a StorageUploader (uploader dep missing)');
    return this.deps.uploader;
  }

  async start(agentId: string): Promise<void> {
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
            chain: this.deps.chain,
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
            chain: this.deps.chain,
            gatewayUrl: this.deps.settings.gatewayUrl,
            defaultModel: this.deps.settings.defaultModel,
            getCoordinator: () => this.coordinator,
            alerts: this.deps.alerts,
            boundaries: this.boundaries,
            approvalTimeoutMs: this.deps.settings.approvalTimeoutMs,
            ...(this.deps.settings.fetchFn ? { fetchFn: this.deps.settings.fetchFn } : {}),
          },
          ctx,
          this.deps.checkpointer,
        );
    const loop: Loop = { stopped: false, timer: null, current: Promise.resolve(), busy: false, pendingApprovalId: null, graph, agent };
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
    if (!pending) return;
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
