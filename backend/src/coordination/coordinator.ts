import type { Pool } from 'pg';
import type { Json } from '../crypto/canonical.js';
import type { SseHub } from '../sse/hub.js';
import type { AlertService } from '../alerts/service.js';
import { approvalEvent, delegationEvent, traceEvent } from '../sse/events.js';
import { appendTrace } from '../trace/trace-store.js';
import { createApproval } from '../store/approvals.js';
import type { AgentRow, Delegation } from '../types.js';
import { getAgentById } from '../store/agents.js';
import { inMinutes } from '../util/format.js';
import {
  createDelegationGuarded,
  findActiveLinkFrom,
  getDelegation,
  listPendingOnInactiveLinkFor,
  listCancellableByLink,
  listOpenByAgent,
  listOrphanedAccepted,
  sweepExpiredDelegations,
  transitionDelegation,
} from './store.js';
import { expireApproval } from '../store/approvals.js';

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
  /** Phase-3 alert engine (optional in coordination-only test setups). */
  alerts?: AlertService | undefined;
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
      await this.traceIssueRejection(input.fromAgent.id, 'delegation_no_active_link', input.kind, input.toAgentId, undefined, input.fromAgent.ownerAddr);
      throw new CoordinationError('delegation_no_active_link', 403);
    }
    const payloadBytes = Buffer.byteLength(JSON.stringify(input.payload), 'utf8');
    if (payloadBytes > settings.delegationPayloadMaxBytes) {
      await this.traceIssueRejection(
        input.fromAgent.id,
        'delegation_payload_too_large',
        input.kind,
        link.toAgentId,
        { payloadBytes, maxBytes: settings.delegationPayloadMaxBytes },
        input.fromAgent.ownerAddr,
      );
      throw new CoordinationError('delegation_payload_too_large', 413);
    }
    // Supervised link (spec §3b): the envelope exists but is NOT delivered —
    // the owner's approval gates activation. Auto: deliver immediately
    // (autonomy-by-default, 00 §1a).
    // P3C-1: throttle check + insert are atomic under a per-link advisory
    // lock (createDelegationGuarded) — a parallel issue burst can no longer
    // slip past the pending/rate bounds between count and insert.
    const supervised = link.mode === 'supervised';
    const guarded = await createDelegationGuarded(
      pool,
      {
        linkId: link.id,
        fromAgentId: input.fromAgent.id,
        toAgentId: link.toAgentId,
        kind: input.kind,
        payload: input.payload,
        status: supervised ? 'pending_approval' : 'pending',
        expiresAt: new Date(Date.now() + settings.delegationTtlMs),
      },
      {
        maxPending: settings.delegationMaxPendingPerLink,
        ratePerHour: settings.delegationRatePerLinkPerHour,
      },
    );
    if (!guarded.ok) {
      const detail =
        guarded.reason === 'delegation_max_pending'
          ? { maxPending: settings.delegationMaxPendingPerLink }
          : { ratePerHour: settings.delegationRatePerLinkPerHour };
      await this.traceIssueRejection(input.fromAgent.id, guarded.reason, input.kind, link.toAgentId, detail, input.fromAgent.ownerAddr);
      throw new CoordinationError(guarded.reason, guarded.reason === 'delegation_max_pending' ? 409 : 429);
    }
    const delegation = guarded.delegation;

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
      // Daily loop (spec §3b): supervised handoffs are the third
      // approval_required source (all three ride the same consent rails).
      // Rich card, server facts only: both agent NAMES, the envelope kind,
      // and the real deadline (the delegation's own TTL — this approval
      // expires with the envelope, not with APPROVAL_TIMEOUT).
      if (this.deps.alerts) {
        const toAgent = await getAgentById(pool, link.toAgentId);
        await this.deps.alerts.emit(input.fromAgent.ownerAddr, {
          agentId: input.fromAgent.id,
          linkId: link.id,
          class: 'decision',
          kind: 'approval_required',
          summary:
            `${input.fromAgent.name} wants to hand a '${input.kind}' task to ${toAgent?.name ?? 'its linked agent'} — ` +
            `it only proceeds if you approve. ⏱ Expires ${inMinutes(settings.delegationTtlMs)} if you don't answer.`,
          refs: {
            approvalId: approval.id,
            delegationId: delegation.id,
            autoDeniesAtUnix: Math.floor(new Date(delegation.expiresAt).getTime() / 1000),
          },
        });
      }
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
   *
   * P3C-2: the approval's OWN agent must be the delegation's issuer — the
   * approval `requestRef` is no longer trusted to name a delegation the
   * approval actually gates. A mismatch is a no-op + error trace (today it
   * would be a cross-owner supervised-consent bypass the day external
   * clients reach the gateway; loopback-only merely hides it).
   */
  async onDelegationApprovalDecision(
    delegationId: string,
    decision: 'approve' | 'deny',
    approvalAgentId: string,
  ): Promise<Delegation | null> {
    const existing = await getDelegation(this.deps.pool, delegationId);
    if (existing && existing.fromAgentId !== approvalAgentId) {
      const rec = await appendTrace(this.deps.pool, {
        agentId: approvalAgentId,
        kind: 'error',
        detail: {
          summary: 'approval/delegation ownership mismatch — decision ignored',
          reason: 'delegation_approval_mismatch',
          delegationId,
          delegationFromAgentId: existing.fromAgentId,
        },
      });
      this.deps.hub.emit(approvalAgentId, 'trace', traceEvent(rec));
      return null;
    }
    // Build note 2 (supervised TTL interaction): with APPROVAL_TIMEOUT ≈
    // DELEGATION_TTL, an approve at the buzzer must not deliver an already-
    // expired envelope — the TTL bounds delivery-to-pickup, and while the
    // envelope waited on the OWNER it was not undelivered. So the expiry
    // restarts from the DECISION time, atomically WITH the approve transition
    // (a separate post-transition reset raced the sweeper at the buzzer).
    const d =
      decision === 'approve'
        ? await transitionDelegation(this.deps.pool, delegationId, ['pending_approval'], 'pending', {
            resetExpiryMs: this.deps.settings.delegationTtlMs,
          })
        : await transitionDelegation(this.deps.pool, delegationId, ['pending_approval'], 'declined', {
            decidedAt: true,
          });
    if (!d) return null; // raced with expiry/cancel — that transition won, already traced
    await this.traceUpdate(d.fromAgentId, d, `owner ${decision === 'approve' ? 'approved' : 'denied'} the handoff`);
    if (decision === 'approve') this.deps.runtime.nudge(d.toAgentId);
    return d;
  }

  /**
   * P3C-4: cancel pending envelopes whose link went inactive — called by the
   * pickup path BEFORE selecting a candidate. Closes the pause-race window
   * (an envelope inserted while the pause was mid-flight survives the pause's
   * cancel pass); traced on BOTH agents' chains so either side's audit shows
   * why the envelope died. Already-accepted envelopes are untouched (spec §4
   * NOTE: accepted runs to completion).
   */
  async cancelInactiveLinkPickups(toAgentId: string): Promise<Delegation[]> {
    const stale = await listPendingOnInactiveLinkFor(this.deps.pool, toAgentId);
    const cancelled: Delegation[] = [];
    for (const row of stale) {
      const d = await transitionDelegation(this.deps.pool, row.id, ['pending'], 'cancelled', { decidedAt: true });
      if (!d) continue; // raced — the winning transition already traced
      const summary = `delegation '${d.kind}' cancelled at pickup: link no longer active`;
      await this.traceUpdate(d.fromAgentId, d, summary);
      await this.traceUpdate(d.toAgentId, d, summary);
      cancelled.push(d);
    }
    return cancelled;
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
    return sweepAndTrace(this.deps.pool, this.deps.hub, this.deps.alerts);
  }

  /** Shared trace + both-sides SSE for every lifecycle transition. */
  private async traceUpdate(traceAgentId: string, d: Delegation, summary: string): Promise<void> {
    await traceDelegationUpdate(this.deps.pool, this.deps.hub, traceAgentId, d, summary, this.deps.alerts);
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
    ownerAddr?: string,
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
    // Daily loop: throttle/quota rejections surface coalesced (spam
    // containment visibility, spec §3b) — one row per (agent, reason, hour).
    if (ownerAddr !== undefined && this.deps.alerts) {
      const hourBucket = new Date().toISOString().slice(0, 13);
      await this.deps.alerts.emit(ownerAddr, {
        agentId,
        class: 'info',
        kind: 'throttle',
        summary: `delegation attempts from this agent are being throttled (${reason.replace('delegation_', '').replace('_', ' ')})`,
        refs: { traceSeq: rec.seq },
        dedupKey: `throttle:${agentId}:${reason}:${hourBucket}`,
      });
    }
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
  alerts?: AlertService,
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
  // Daily loop (spec §3b taxonomy): failed | expired | declined | cancelled
  // surface as ONE info alert per envelope (dedup key = the delegation id —
  // both-sides tracing cannot double-alert). Completions ride the digest, not
  // the inbox: no chore queue (00 §1a).
  if (alerts && (d.status === 'failed' || d.status === 'expired' || d.status === 'declined' || d.status === 'cancelled')) {
    const link = await getLinkOwner(pool, d.linkId);
    if (link) {
      await alerts.emit(link, {
        agentId: d.fromAgentId,
        linkId: d.linkId,
        class: 'info',
        kind: 'delegation_terminal',
        summary,
        refs: { delegationId: d.id, traceSeq: rec.seq },
        dedupKey: `delegation_terminal:${d.id}`,
      });
    }
  }
}

async function getLinkOwner(pool: Pool, linkId: string): Promise<string | null> {
  const res = await pool.query<{ owner_addr: string }>(`SELECT owner_addr FROM links WHERE id = $1`, [linkId]);
  return res.rows[0]?.owner_addr ?? null;
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
async function sweepAndTrace(pool: Pool, hub: SseHub, alerts?: AlertService): Promise<Delegation[]> {
  const swept = await sweepExpiredDelegations(pool);
  for (const d of swept) {
    await traceDelegationUpdate(pool, hub, d.fromAgentId, d, `delegation '${d.kind}' expired`, alerts);
    // Gate finding: a supervised envelope expiring mid-approval leaves its
    // approval card dangling forever (nobody will ever deliver a decision to
    // a terminal delegation). Expire the linked approval chain-visibly, the
    // same shape the approval-timeout paths use.
    await expireLinkedApprovals(pool, hub, d, alerts);
  }
  return swept;
}

/** Expire pending approval rows that gate a now-terminal delegation. */
async function expireLinkedApprovals(pool: Pool, hub: SseHub, d: Delegation, alerts?: AlertService): Promise<void> {
  const rows = await pool.query<{ id: string; request_ref: Json }>(
    `SELECT id, request_ref FROM approvals
     WHERE agent_id = $1 AND state = 'pending'
       AND request_ref->>'type' = 'delegation' AND request_ref->>'delegationId' = $2`,
    [d.fromAgentId, d.id],
  );
  for (const row of rows.rows) {
    const expired = await expireApproval(pool, row.id);
    if (!expired) continue; // raced with a decision — that path already traced consent
    const consent = await appendTrace(pool, {
      agentId: d.fromAgentId,
      kind: 'consent',
      approvalId: row.id,
      decision: 'expired',
      decidedBy: 'system',
      originalRequest: row.request_ref,
      detail: { reason: 'supervised delegation expired before a decision' },
    });
    hub.emit(d.fromAgentId, 'trace', traceEvent(consent));
    hub.emit(d.fromAgentId, 'approval_decided', {
      type: 'approval_decided',
      approvalId: row.id,
      decision: 'expired',
    });
    await alerts?.resolveByApproval(row.id, {
      resolution: 'expired',
      via: 'system',
      agentId: d.fromAgentId,
      consentSeq: consent.seq,
    });
  }
}

/**
 * Expiry point C (spec §3b + C-6 startup sweep): after a crash/restart any
 * already-stale pending/pending_approval delegation is an orphan — expire it
 * terminally and chain-visibly before the loops start. Runs next to
 * sweepOrphanedApprovals in the composition root.
 */
export async function runBootSweep(pool: Pool, hub: SseHub, alerts?: AlertService): Promise<Delegation[]> {
  const expired = await sweepAndTrace(pool, hub, alerts);
  // Gate finding: an 'accepted' row is an in-flight cycle; after a restart
  // that cycle no longer exists (per-cycle thread ids; pickup takes only
  // 'pending') — without this, the envelope dangles as a zombie forever.
  // BOOT ONLY: while loops are live, accepted rows are legitimately in flight.
  const orphans = await listOrphanedAccepted(pool);
  const failed: Delegation[] = [];
  for (const row of orphans) {
    const d = await transitionDelegation(pool, row.id, ['accepted'], 'failed', {
      result: { error: 'orphaned by restart' },
      decidedAt: true,
    });
    if (!d) continue;
    await traceDelegationUpdate(pool, hub, d.toAgentId, d, `delegation '${d.kind}' failed: orphaned by restart`, alerts);
    failed.push(d);
  }
  return [...expired, ...failed];
}
