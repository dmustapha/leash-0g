import type { Json } from '../crypto/canonical.js';
import type { DelegationEvent, DelegationStatus, TraceRecord } from '../types.js';

/**
 * FE stream-event contract (web/lib/types.ts StreamEvent): the FE SSE client
 * parses ONLY the data payload and discriminates on `type` — the SSE `event:`
 * name is ignored. Every hub emission must therefore carry a `type` field and
 * match these shapes exactly.
 */
export type StreamStatus = 'running' | 'paused' | 'revoked';

export function statusEvent(status: StreamStatus): Json {
  return { type: 'status', status, ts: new Date().toISOString() };
}

export function reasoningEvent(text: string): Json {
  return { type: 'reasoning', text, ts: new Date().toISOString() };
}

export function approvalEvent(input: { approvalId: string; summary: string; to?: string; valueWei?: string }): Json {
  return {
    type: 'approval',
    approvalId: input.approvalId,
    summary: input.summary,
    ...(input.to !== undefined ? { to: input.to } : {}),
    ...(input.valueWei !== undefined ? { valueWei: input.valueWei } : {}),
    ts: new Date().toISOString(),
  };
}

/**
 * Delegation lifecycle event (spec §4 DelegationEvent) — emitted on BOTH
 * agents' streams at every transition, direction flipped per side.
 */
export function delegationEvent(input: {
  delegationId: string;
  linkId: string;
  status: DelegationStatus;
  kind: string;
  counterpartyAgentId: string;
  direction: 'outbound' | 'inbound';
}): DelegationEvent {
  return {
    type: 'delegation',
    delegationId: input.delegationId,
    linkId: input.linkId,
    status: input.status,
    kind: input.kind,
    counterpartyAgentId: input.counterpartyAgentId,
    direction: input.direction,
    ts: new Date().toISOString(),
  };
}

/** Map a persisted TraceRecord to the FE trace event (summary + action fields). */
export function traceEvent(rec: TraceRecord): Json {
  const detail = (rec.detail && typeof rec.detail === 'object' && !Array.isArray(rec.detail) ? rec.detail : {}) as Record<
    string,
    Json | undefined
  >;
  const to = typeof detail['to'] === 'string' ? detail['to'] : undefined;
  const valueWei = typeof detail['valueWei'] === 'string' ? detail['valueWei'] : undefined;
  const txHash = typeof detail['txHash'] === 'string' ? detail['txHash'] : undefined;
  return {
    type: 'trace',
    kind: rec.kind,
    seq: rec.seq,
    ts: rec.ts,
    summary: summarize(rec, detail),
    ...(to !== undefined ? { to } : {}),
    ...(valueWei !== undefined ? { valueWei } : {}),
    ...(txHash !== undefined ? { txHash } : {}),
  };
}

function summarize(rec: TraceRecord, detail: Record<string, Json | undefined>): string {
  if (typeof detail['summary'] === 'string') return detail['summary'];
  switch (rec.kind) {
    case 'inference':
      return firstUserContent(rec.originalRequest) ?? 'inference via gateway';
    case 'modify':
      return 'request modified by policy before forwarding';
    case 'block':
      return 'request blocked by policy';
    case 'consent':
      if (rec.decision === 'expired') return 'approval expired (owner did not decide in time)';
      return `owner ${rec.decision === 'approve' ? 'approved' : 'denied'} the request`;
    case 'revoke':
      return 'agent revoked';
    case 'action':
      return 'on-chain action';
    case 'error':
      return 'upstream forward failed';
    case 'decision':
      return typeof detail['reason'] === 'string' ? detail['reason'] : 'agent decision';
    default:
      return rec.kind;
  }
}

/** Short human summary of an OpenAI-shaped request (latest user message). */
export function requestSummary(request: Json | undefined): string {
  return firstUserContent(request) ?? 'inference request';
}

function firstUserContent(request: Json | undefined): string | undefined {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return undefined;
  const messages = (request as Record<string, Json | undefined>)['messages'];
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && typeof m === 'object' && !Array.isArray(m)) {
      const rec = m as Record<string, Json | undefined>;
      if (rec['role'] === 'user' && typeof rec['content'] === 'string') {
        const text = rec['content'];
        return text.length > 140 ? `${text.slice(0, 137)}...` : text;
      }
    }
  }
  return undefined;
}
