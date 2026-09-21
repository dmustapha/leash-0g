// File: web/lib/delegations.ts
// Pure helpers for the pair-view delegation timeline: merge live `delegation` SSE events
// into the fetched feed (spec §3c). Both agents' streams emit the same event, so the merge
// must be idempotent per (delegationId, status).

import type { Delegation, DelegationEvent, DelegationStatus } from './types';

export const TERMINAL_STATUSES: ReadonlySet<DelegationStatus> = new Set([
  'completed',
  'failed',
  'declined',
  'cancelled',
  'expired',
]);

/** Plain-language labels for delegation statuses (00 §2c). */
export const DELEGATION_STATUS_LABEL: Record<DelegationStatus, string> = {
  pending_approval: 'waiting for you',
  pending: 'waiting for the other agent',
  accepted: 'being worked on',
  completed: 'done',
  failed: 'failed',
  declined: 'you declined',
  cancelled: 'cancelled',
  expired: 'expired',
};

/**
 * Merge one live event into the list. Known id → update status (never regress a terminal
 * state); unknown id → prepend a stub row so the timeline shows activity before the next
 * refetch fills in payload details. Returns a new array; never mutates.
 */
export function applyDelegationEvent(list: Delegation[], ev: DelegationEvent): Delegation[] {
  const idx = list.findIndex((d) => d.id === ev.delegationId);
  if (idx >= 0) {
    const existing = list[idx] as Delegation;
    if (TERMINAL_STATUSES.has(existing.status)) return list;
    const next = [...list];
    next[idx] = { ...existing, status: ev.status, decidedAt: ev.ts };
    return next;
  }
  const outbound = ev.direction === 'outbound';
  const stub: Delegation = {
    id: ev.delegationId,
    linkId: ev.linkId,
    // The event names only the counterparty; the stream owner fills the other side.
    fromAgentId: outbound ? '' : ev.counterpartyAgentId,
    toAgentId: outbound ? ev.counterpartyAgentId : '',
    kind: ev.kind,
    payload: null,
    status: ev.status,
    createdAt: ev.ts,
    expiresAt: ev.ts,
  };
  return [stub, ...list];
}
