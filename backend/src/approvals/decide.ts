import type { Pool } from 'pg';
import type { SseHub } from '../sse/hub.js';
import type { ApprovalBroker } from './broker.js';
import type { AlertService } from '../alerts/service.js';
import type { DelegationCoordinator } from '../coordination/coordinator.js';
import type { ApprovalRow, AgentRow, AlertChannel } from '../types.js';
import { decideApproval } from '../store/approvals.js';
import { appendTrace } from '../trace/trace-store.js';
import { traceEvent } from '../sse/events.js';

export interface DecideDeps {
  pool: Pool;
  hub: SseHub;
  broker: ApprovalBroker;
  coordinator: DelegationCoordinator;
  alerts: AlertService;
}

export type DecideOutcome =
  | { ok: true; state: ApprovalRow['state']; consentSeq: number }
  | { ok: false; reason: 'already_decided' };

/**
 * THE owner decision path (spec §3b "the SAME consent rails"): shared verbatim
 * by POST /api/approvals/:id and the Telegram inline callback — a Telegram
 * approval is a consent record like any other, distinguished only by
 * `channel` in the consent detail (additive, spec §4).
 *
 * Ordering invariants preserved from Phase 1/2: the durable consent record is
 * appended strictly BEFORE broker.notify (consent-seq < action-seq, C-3
 * rendezvous untouched); the supervised-delegation activation runs AFTER the
 * consent append; alert resolution is post-consent bookkeeping.
 */
export async function decideApprovalWithConsent(
  deps: DecideDeps,
  agent: AgentRow,
  approval: ApprovalRow,
  decision: 'approve' | 'deny',
  opts: { channel: AlertChannel; reason?: string | undefined },
): Promise<DecideOutcome> {
  const decided = await decideApproval(deps.pool, approval.id, decision, opts.reason);
  if (!decided) return { ok: false, reason: 'already_decided' };

  const consent = await appendTrace(deps.pool, {
    agentId: agent.id,
    kind: 'consent',
    approvalId: approval.id,
    decision,
    decidedBy: 'owner',
    originalRequest: approval.requestRef,
    detail: {
      channel: opts.channel,
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    },
  });
  deps.hub.emit(agent.id, 'trace', traceEvent(consent));
  deps.broker.notify(approval.id, {
    decision,
    ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
  });
  deps.hub.emit(agent.id, 'approval_decided', {
    type: 'approval_decided',
    approvalId: approval.id,
    decision,
  });

  // Supervised handoff (spec §3b): a delegation-class approval activates (or
  // declines) the envelope — strictly AFTER the consent append above.
  // P3C-2: the approval's agent binds the decision.
  const ref = approval.requestRef;
  if (ref !== null && typeof ref === 'object' && !Array.isArray(ref) && ref['type'] === 'delegation') {
    const delegationId = ref['delegationId'];
    if (typeof delegationId === 'string') {
      await deps.coordinator.onDelegationApprovalDecision(delegationId, decision, agent.id);
    }
  }

  // Daily loop: the decision alert auto-resolves on ANY channel.
  await deps.alerts.resolveByApproval(approval.id, {
    resolution: decision,
    via: opts.channel,
    agentId: agent.id,
    consentSeq: consent.seq,
  });

  return { ok: true, state: decided.state, consentSeq: consent.seq };
}
