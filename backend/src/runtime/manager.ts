import { randomUUID } from 'node:crypto';
import { Command, type BaseCheckpointSaver } from '@langchain/langgraph';
import type { Pool } from 'pg';
import type { RuntimeManager } from '../server.js';
import type { SseHub } from '../sse/hub.js';
import type { ApprovalBroker, ApprovalDecision } from '../approvals/broker.js';
import { getAgentById } from '../store/agents.js';
import { getApproval } from '../store/approvals.js';
import { decryptSecret } from '../crypto/keycrypt.js';
import { appendTrace } from '../trace/trace-store.js';
import { traceEvent } from '../sse/events.js';
import type { AgentRow } from '../types.js';
import type { RuntimeChain } from './session-chain.js';
import { buildTreasuryGraph, type TreasuryGraph } from './treasury-graph.js';

export interface RuntimeSettings {
  keyEncryptionSecret: string;
  approvalTimeoutMs: number;
  /** Base URL of OUR OWN gateway (loopback in prod) — set after listen(). */
  gatewayUrl: string;
  intervalMs: number;
  defaultModel: string;
  fetchFn?: typeof fetch;
}

export interface RuntimeManagerDeps {
  pool: Pool;
  hub: SseHub;
  broker: ApprovalBroker;
  chain: RuntimeChain;
  checkpointer: BaseCheckpointSaver;
  settings: RuntimeSettings;
}

interface Loop {
  stopped: boolean;
  timer: NodeJS.Timeout | null;
  current: Promise<void>;
  pendingApprovalId: string | null;
  graph: TreasuryGraph;
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

  constructor(private readonly deps: RuntimeManagerDeps) {}

  async start(agentId: string): Promise<void> {
    if (this.loops.has(agentId)) return;
    const agent = await getAgentById(this.deps.pool, agentId);
    if (!agent || agent.status !== 'active') throw new Error('agent not startable');
    if (!agent.gatewayTokenEnc) throw new Error('agent has no runtime gateway token');
    const { keyEncryptionSecret } = this.deps.settings;
    const graph = buildTreasuryGraph(
      {
        pool: this.deps.pool,
        hub: this.deps.hub,
        chain: this.deps.chain,
        gatewayUrl: this.deps.settings.gatewayUrl,
        defaultModel: this.deps.settings.defaultModel,
        ...(this.deps.settings.fetchFn ? { fetchFn: this.deps.settings.fetchFn } : {}),
      },
      {
        agentId: agent.id,
        accountAddr: agent.accountAddr,
        goal: agent.goal,
        sessionPrivateKey: decryptSecret(agent.sessionKeyEnc, keyEncryptionSecret),
        gatewayToken: decryptSecret(agent.gatewayTokenEnc, keyEncryptionSecret),
      },
      this.deps.checkpointer,
    );
    const loop: Loop = { stopped: false, timer: null, current: Promise.resolve(), pendingApprovalId: null, graph, agent };
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
      loop.current = this.runCycle(loop)
        .catch(async (err: unknown) => this.recordFailure(loop.agent.id, err))
        .finally(() => this.schedule(loop, this.deps.settings.intervalMs));
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
    const config = { configurable: { thread_id: `${loop.agent.id}:${randomUUID()}` } };
    await loop.graph.invoke({}, config);

    const snapshot = await loop.graph.getState(config);
    // 0.2.x: pending interrupts live on tasks[].interrupts, NOT result.__interrupt__ (PHASE-0 §1b).
    const pending = snapshot.tasks.flatMap((t) => t.interrupts)[0];
    if (!pending) return;
    const { approvalId } = pending.value as { approvalId: string };

    loop.pendingApprovalId = approvalId;
    const decision = await this.awaitDecision(approvalId);
    loop.pendingApprovalId = null;

    const resolved: ApprovalDecision =
      decision === 'timeout' ? { decision: 'deny', reason: 'approval timed out' } : decision;
    if (decision !== 'timeout') {
      // Ordered consent record persisted BEFORE the resumed run can act (spec §3b).
      const consent = await appendTrace(this.deps.pool, {
        agentId: loop.agent.id,
        kind: 'consent',
        approvalId,
        decision: resolved.decision,
        decidedBy: 'owner',
        ...(resolved.reason !== undefined ? { detail: { reason: resolved.reason } } : {}),
      });
      this.deps.hub.emit(loop.agent.id, 'trace', traceEvent(consent));
    }
    await loop.graph.invoke(new Command({ resume: resolved }), config);
  }

  /**
   * Rendezvous with the owner's decision. The broker only wakes a LIVE
   * waiter — a decision can land durably in Postgres BEFORE this waiter
   * registers (the API notifies into the void while the graph is still
   * checkpointing its interrupt). So: register the waiter first, then check
   * the durable state, and re-check once more on timeout.
   */
  private async awaitDecision(approvalId: string): Promise<ApprovalDecision | 'timeout'> {
    const waited = this.deps.broker.wait(approvalId, this.deps.settings.approvalTimeoutMs);
    const early = await this.decidedInDb(approvalId);
    if (early) {
      this.deps.broker.notify(approvalId, early); // settle the dangling waiter
      return early;
    }
    const decision = await waited;
    if (decision !== 'timeout') return decision;
    return (await this.decidedInDb(approvalId)) ?? 'timeout';
  }

  private async decidedInDb(approvalId: string): Promise<ApprovalDecision | null> {
    const row = await getApproval(this.deps.pool, approvalId);
    if (!row || row.state === 'pending') return null;
    return {
      decision: row.state === 'approved' ? 'approve' : 'deny',
      ...(row.reason !== null ? { reason: row.reason } : {}),
    };
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
    } catch (traceErr) {
      console.error(`failed to record runtime failure for agent ${agentId}`, traceErr);
    }
  }
}
