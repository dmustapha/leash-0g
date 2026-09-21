import type { Pool } from 'pg';
import type { Json } from '../crypto/canonical.js';
import type { SseHub } from '../sse/hub.js';
import { approvalEvent, delegationEvent, traceEvent } from '../sse/events.js';
import { appendTrace } from '../trace/trace-store.js';
import { createApproval } from '../store/approvals.js';
import type { AgentRow, Delegation } from '../types.js';
import {
  countPendingByLink,
  countRecentByLink,
  createDelegation,
  findActiveLinkFrom,
  listCancellableByLink,
  listOpenByAgent,
  sweepExpiredDelegations,
  transitionDelegation,
} from './store.js';

/**
 * Delegation coordinator (spec §3b "Coordination layer"). Owns the envelope
 * lifecycle end-to-end: issuance (link authz + channel throttles), supervised
 * approval gating, receiver-side transitions, link/revoke cancellation, and
 * three-point expiry. kind/payload stay opaque throughout (generality guard).
 *
 * Delegations carry ZERO authority (00 §6c): everything here is bookkeeping +
 * containment — the receiver's own on-chain policy binds the outcome.
 */

export type IssueRejectionReason =
  | 'delegation_no_active_link'
  | 'delegation_payload_too_large'
  | 'delegation_max_pending'
  | 'delegation_rate_limited';

/** Typed issuance rejection; httpStatus maps to the API layer's error class. */
export class CoordinationError extends Error {
  constructor(
    public readonly reason: IssueRejectionReason,
    public readonly httpStatus: 403 | 413 | 429 | 409,
  ) {
    super(reason);
    this.name = 'CoordinationError';
  }
}

export interface CoordinatorSettings {
  delegationTtlMs: number;
  delegationRatePerLinkPerHour: number;
  delegationMaxPendingPerLink: number;
  delegationPayloadMaxBytes: number;
}

export interface CoordinatorDeps {
  pool: Pool;
  hub: SseHub;
  /** Delivery-latency nudge only — poll remains the correctness path (spec §3b). */
  runtime: { nudge(agentId: string): void };
  settings: CoordinatorSettings;
}

export interface IssueDelegationInput {
  fromAgent: AgentRow;
  kind: string;
  payload: Json;
  toAgentId?: string;
}

export class DelegationCoordinator {
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: CoordinatorDeps) {}

  /**
   * Issue an envelope over the issuer's ACTIVE link. Throttles run BEFORE the
   * insert (spec §3b channel bounds); every rejection is traced on the
   * ISSUER's chain with a machine-readable reason, then thrown.
   */
  async issueDelegation(input: IssueDelegationInput): Promise<Delegation> {
    const { pool, hub, settings } = this.deps;
    const link = await findActiveLinkFrom(pool, input.fromAgent.id, input.toAgentId);
    if (!link) {
      // No link / paused / removed / wrong direction / cross-owner target —
      // all collapse to "no active channel" (links are the ONLY authorization).
      await this.traceIssueRejection(input.fromAgent.id, 'delegation_no_active_link', input.kind, input.toAgentId);
      throw new CoordinationError('delegation_no_active_link', 403);
    }
    const payloadBytes = Buffer.byteLength(JSON.stringify(input.payload), 'utf8');
    if (payloadBytes > settings.delegationPayloadMaxBytes) {
      await this.traceIssueRejection(input.fromAgent.id, 'delegation_payload_too_large', input.kind, link.toAgentId, {
        payloadBytes,
        maxBytes: settings.delegationPayloadMaxBytes,
      });
      throw new CoordinationError('delegation_payload_too_large', 413);
    }
    if ((await countPendingByLink(pool, link.id)) >= settings.delegationMaxPendingPerLink) {
      await this.traceIssueRejection(input.fromAgent.id, 'delegation_max_pending', input.kind, link.toAgentId, {
        maxPending: settings.delegationMaxPendingPerLink,
      });
      throw new CoordinationError('delegation_max_pending', 409);
    }
    if ((await countRecentByLink(pool, link.id)) >= settings.delegationRatePerLinkPerHour) {
      await this.traceIssueRejection(input.fromAgent.id, 'delegation_rate_limited', input.kind, link.toAgentId, {
        ratePerHour: settings.delegationRatePerLinkPerHour,
      });
      throw new CoordinationError('delegation_rate_limited', 429);
    }

    // Supervised link (spec §3b): the envelope exists but is NOT delivered —
    // the owner's approval gates activation. Auto: deliver immediately
    // (autonomy-by-default, 00 §1a).
    const supervised = link.mode === 'supervised';
    const delegation = await createDelegation(pool, {
      linkId: link.id,
      fromAgentId: input.fromAgent.id,
      toAgentId: link.toAgentId,
      kind: input.kind,
      payload: input.payload,
      status: supervised ? 'pending_approval' : 'pending',
      expiresAt: new Date(Date.now() + settings.delegationTtlMs),
    });

    if (supervised) {
      const approval = await createApproval(pool, input.fromAgent.id, {
        type: 'delegation',
        delegationId: delegation.id,
        kind: input.kind,
        toAgentId: link.toAgentId,
      });
      hub.emit(
        input.fromAgent.id,
        'approval',
        approvalEvent({
          approvalId: approval.id,
          summary: `handoff awaiting your approval: '${input.kind}' from ${input.fromAgent.name} to agent ${link.toAgentId}`,
        }),
      );
    } else {
      this.deps.runtime.nudge(link.toAgentId);
    }

    // Issuer-side 'delegate' trace — the payload rides in the ENCRYPTED trace
    // record (owner-only decrypt, spec D3); the SSE frame carries status only.
    const rec = await appendTrace(pool, {
      agentId: input.fromAgent.id,
      kind: 'delegate',
      detail: {
        summary: `delegated '${input.kind}' to agent ${link.toAgentId}${supervised ? ' (awaiting owner approval)' : ''}`,
        delegationId: delegation.id,
        counterpartyAgentId: link.toAgentId,
        kind: input.kind,
        payload: input.payload,
      },
    });
    hub.emit(input.fromAgent.id, 'trace', traceEvent(rec));
    this.emitBothSides(delegation);
    return delegation;
  }

  /**
   * Owner decision on a supervised handoff (called from POST /api/approvals/:id
   * AFTER the consent record is durable — consent-seq strictly precedes
   * delivery). approve → pending + nudge; deny → declined.
   */
  async onDelegationApprovalDecision(delegationId: string, decision: 'approve' | 'deny'): Promise<Delegation | null> {
    const d =
      decision === 'approve'
        ? await transitionDelegation(this.deps.pool, delegationId, ['pending_approval'], 'pending')
        : await transitionDelegation(this.deps.pool, delegationId, ['pending_approval'], 'declined', {
            decidedAt: true,
          });
    if (!d) return null; // raced with expiry/cancel — that transition won, already traced
    await this.traceUpdate(d.fromAgentId, d, `owner ${decision === 'approve' ? 'approved' : 'denied'} the handoff`);
    if (decision === 'approve') this.deps.runtime.nudge(d.toAgentId);
    return d;
  }

  /** Receiver picked the envelope up (refusal of expired rows happens at the pickup query). */
  async markAccepted(delegationId: string): Promise<Delegation | null> {
    const d = await transitionDelegation(this.deps.pool, delegationId, ['pending'], 'accepted');
    if (!d) return null;
    await this.traceUpdate(d.toAgentId, d, `accepted delegation '${d.kind}'`);
    return d;
  }

  /** Receiver finished the delegated work; result (e.g. {txHash}) rides the row. */
  async markCompleted(delegationId: string, result: Json): Promise<Delegation | null> {
    const d = await transitionDelegation(this.deps.pool, delegationId, ['accepted'], 'completed', {
      result,
      decidedAt: true,
    });
    if (!d) return null;
    await this.traceUpdate(d.toAgentId, d, `completed delegation '${d.kind}'`);
    return d;
  }

  /** Act failed / over-policy stand-down / receiver-side approval denied (spec §4). */
  async markFailed(delegationId: string, error: string): Promise<Delegation | null> {
    const d = await transitionDelegation(this.deps.pool, delegationId, ['accepted'], 'failed', {
      result: { error },
      decidedAt: true,
    });
    if (!d) return null;
    await this.traceUpdate(d.toAgentId, d, `delegation '${d.kind}' failed: ${error}`);
    return d;
  }

  /** Receiver declines an undelivered envelope without accepting it. */
  async markDeclinedByReceiver(delegationId: string, reason?: string): Promise<Delegation | null> {
    const d = await transitionDelegation(this.deps.pool, delegationId, ['pending'], 'declined', { decidedAt: true });
    if (!d) return null;
    await this.traceUpdate(d.toAgentId, d, `declined delegation '${d.kind}'${reason ? `: ${reason}` : ''}`);
    return d;
  }

  /**
   * Link pause/remove: cancel ONLY pending/pending_approval — an accepted
   * (in-flight) delegation runs to completion (spec §4 NOTE: the receiver's
   * own on-chain policy still bounds it; killing mid-act adds a race for no
   * containment gain).
   */
  async cancelForLink(linkId: string, reason: string): Promise<Delegation[]> {
    const open = await listCancellableByLink(this.deps.pool, linkId);
    const cancelled: Delegation[] = [];
    for (const row of open) {
      const d = await transitionDelegation(this.deps.pool, row.id, ['pending', 'pending_approval'], 'cancelled', {
        decidedAt: true,
      });
      if (!d) continue; // raced — the winning transition already traced
      await this.traceUpdate(d.fromAgentId, d, `delegation '${d.kind}' cancelled: ${reason}`);
      cancelled.push(d);
    }
    return cancelled;
  }

  /**
   * Revoke fan-out over the coordination layer (spec §3b): the revoked agent's
   * outbound pending/pending_approval are cancelled, undelivered inbound are
   * declined, and in-flight inbound fail with 'revoked' (the act can no longer
   * land — post-revoke execute reverts). All traced on the REVOKED agent's
   * chain; counterparties see the transition over SSE.
   */
  async cancelForRevokedAgent(agentId: string): Promise<void> {
    const open = await listOpenByAgent(this.deps.pool, agentId);
    for (const row of open) {
      let d: Delegation | null = null;
      let summary = '';
      if (row.fromAgentId === agentId) {
        d = await transitionDelegation(this.deps.pool, row.id, ['pending', 'pending_approval'], 'cancelled', {
          decidedAt: true,
        });
        summary = `outbound delegation '${row.kind}' cancelled: issuer revoked`;
      } else if (row.status === 'accepted') {
        d = await transitionDelegation(this.deps.pool, row.id, ['accepted'], 'failed', {
          result: { error: 'revoked' },
          decidedAt: true,
        });
        summary = `in-flight delegation '${row.kind}' failed: receiver revoked`;
      } else {
        d = await transitionDelegation(this.deps.pool, row.id, ['pending', 'pending_approval'], 'declined', {
          decidedAt: true,
        });
        summary = `inbound delegation '${row.kind}' declined: receiver revoked`;
      }
      if (!d) continue; // raced — the winning transition already traced
      await this.traceUpdate(agentId, d, summary);
    }
  }

  /**
   * Expiry point B (spec §3b): periodic sweeper for stale envelopes. 60s
   * default ≪ the 10-min TTL — an expired row is terminal within a minute of
   * its deadline even if nobody ever polls it.
   */
  startSweeper(intervalMs = 60_000): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      void this.sweepOnce().catch((err: unknown) => console.error('delegation sweeper tick failed', err));
    }, intervalMs);
    this.sweepTimer.unref();
  }

  stopSweeper(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /** One sweep pass (timer-driven; also called directly by tests). */
  async sweepOnce(): Promise<Delegation[]> {
    return sweepAndTrace(this.deps.pool, this.deps.hub);
  }

  /** Shared trace + both-sides SSE for every lifecycle transition. */
  private async traceUpdate(traceAgentId: string, d: Delegation, summary: string): Promise<void> {
    await traceDelegationUpdate(this.deps.pool, this.deps.hub, traceAgentId, d, summary);
  }

  private emitBothSides(d: Delegation): void {
    emitDelegationBothSides(this.deps.hub, d);
  }

  private async traceIssueRejection(
    agentId: string,
    reason: IssueRejectionReason,
    kind: string,
    toAgentId?: string,
    extra?: Record<string, Json>,
  ): Promise<void> {
    const rec = await appendTrace(this.deps.pool, {
      agentId,
      kind: 'error',
      detail: {
        summary: `delegation issuance rejected: ${reason}`,
        reason,
        kind,
        ...(toAgentId !== undefined ? { toAgentId } : {}),
        ...extra,
      },
    });
    this.deps.hub.emit(agentId, 'trace', traceEvent(rec));
  }
}

// ---------------------------------------------------------------------------
// Module-level lifecycle plumbing — shared by the coordinator instance and the
// boot sweep (which runs before any coordinator/runtime exists).
// ---------------------------------------------------------------------------

async function traceDelegationUpdate(
  pool: Pool,
  hub: SseHub,
  traceAgentId: string,
  d: Delegation,
  summary: string,
): Promise<void> {
  const rec = await appendTrace(pool, {
    agentId: traceAgentId,
    kind: 'delegation_update',
    detail: {
      summary,
      delegationId: d.id,
      status: d.status,
      kind: d.kind,
      counterpartyAgentId: traceAgentId === d.fromAgentId ? d.toAgentId : d.fromAgentId,
      ...(d.result !== undefined ? { result: d.result } : {}),
    },
  });
  hub.emit(traceAgentId, 'trace', traceEvent(rec));
  emitDelegationBothSides(hub, d);
}

function emitDelegationBothSides(hub: SseHub, d: Delegation): void {
  hub.emit(
    d.fromAgentId,
    'delegation',
    delegationEvent({
      delegationId: d.id,
      linkId: d.linkId,
      status: d.status,
      kind: d.kind,
      counterpartyAgentId: d.toAgentId,
      direction: 'outbound',
    }),
  );
  hub.emit(
    d.toAgentId,
    'delegation',
    delegationEvent({
      delegationId: d.id,
      linkId: d.linkId,
      status: d.status,
      kind: d.kind,
      counterpartyAgentId: d.fromAgentId,
      direction: 'inbound',
    }),
  );
}

/** Expire stale envelopes + trace each on the issuer's chain (expiry points B and C). */
async function sweepAndTrace(pool: Pool, hub: SseHub): Promise<Delegation[]> {
  const swept = await sweepExpiredDelegations(pool);
  for (const d of swept) {
    await traceDelegationUpdate(pool, hub, d.fromAgentId, d, `delegation '${d.kind}' expired`);
  }
  return swept;
}

/**
 * Expiry point C (spec §3b + C-6 startup sweep): after a crash/restart any
 * already-stale pending/pending_approval delegation is an orphan — expire it
 * terminally and chain-visibly before the loops start. Runs next to
 * sweepOrphanedApprovals in the composition root.
 */
export async function runBootSweep(pool: Pool, hub: SseHub): Promise<Delegation[]> {
  return sweepAndTrace(pool, hub);
}
