import type { Json } from '../crypto/canonical.js';
import type { DelegationEvent, DelegationStatus, TraceRecord } from '../types.js';
import { sanitizeAgentIntent } from '../util/format.js';

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

/**
 * AQ-A0-Q2VIS D-2/D-4: the `reasoning` event used to carry `completionContent()` — i.e. the
 * decision JSON — so the cockpit's reasoning disclosure showed the owner a JSON blob instead of
 * the agent's thinking. That is F-0b-34/35, and it is why Q2 was ungradable.
 *
 * Defect-2 / option (a) then settled what this payload IS, at the surface rather than here: the
 * cockpit now labels it "Show the exact model output (raw, for review only)" and precedes it with
 * a plain line, because a measured probe found 92/100 deliberations carry prompt scaffolding and
 * prompt wording removed only 8 of them. No producer change followed from that ruling — this
 * event's contract is unchanged, and §9-D bars filtering the prose on the way out.
 *
 * `text` is now the DELIBERATION (`reasoning_content`, populated on 100% of healthy cycles).
 * `meta` carries the health of the cycle so the surface can degrade instead of rendering 64 KB of
 * repetition when the model loops (C-5):
 *  - `truncated` — the cycle hit the token cap. Measured at n=200 this is a PERFECT separator for
 *    the degenerate population (healthy max 3 538 completion tokens, truncated all exactly 4 096),
 *    unlike `loopCount`, whose healthy/degenerate ranges overlap at 6..14.
 *  - `loopCount` — severity, not classification: how many times the answer was restated.
 *  - `decisionSource` — `'scavenge'` means the decision was recovered from this deliberation
 *    because `content` was starved (the G-6 counter).
 *  - `clipped` — the deliberation was longer than the transport cap and was shortened.
 */
export interface ReasoningMeta {
  truncated: boolean;
  loopCount: number;
  decisionSource: 'content' | 'scavenge' | 'empty';
  clipped: boolean;
}

export function reasoningEvent(text: string, meta?: ReasoningMeta): Json {
  return { type: 'reasoning', text, ...(meta ? { meta: { ...meta } } : {}), ts: new Date().toISOString() };
}

export function approvalEvent(input: {
  approvalId: string;
  summary: string;
  to?: string;
  valueWei?: string;
  /** Pre-formatted true asset (e.g. "2 USDC"). Absent ⇒ native 0G approval. */
  assetLabel?: string;
}): Json {
  return {
    type: 'approval',
    approvalId: input.approvalId,
    summary: input.summary,
    ...(input.to !== undefined ? { to: input.to } : {}),
    ...(input.valueWei !== undefined ? { valueWei: input.valueWei } : {}),
    ...(input.assetLabel !== undefined ? { assetLabel: input.assetLabel } : {}),
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
  // Q5 (presentation): the plain-language WHY (model's own decision reason) rides
  // the live frame so the cockpit shows a legible "why it acted", not just "what".
  const reason = typeof detail['reason'] === 'string' && detail['reason'] !== '' ? detail['reason'] : undefined;
  // AQ-A0-Q2VIS D-4 owner layer — the agent's plain-language explanation.
  //
  // It is carried as ATTRIBUTED, QUARANTINED agent voice, never as a verified claim. That is a
  // deliberate reversal of this field's first design, and the reason is worth keeping:
  //
  // The first version gated display on `rationaleAnchored()` — a lexical check that the prose
  // agreed with the decision — so an anchored rationale was effectively presented as verified.
  // THREE independent Gate-② review rounds each defeated that check (negation-blindness, then
  // contrastives / multi-sentence disagreement / em-dash boundaries, then double negation,
  // "cannot stand down", a `without`-governed clause, and a substring collision where
  // "10.01 0G".includes("0.01 0G")). A deliberately strict rewrite still leaked 2 of 5 while
  // suppressing 22% of real stand-down explanations. The conclusion is structural, not a missing
  // regex: **whether free prose entails a decision is not lexically decidable**, so no such check
  // can justify promoting model text to "verified".
  //
  // So nothing is promoted. The authoritative WHAT stays the server-composed `summary` (built from
  // the verified decision — correct by construction), and this field is the agent's own words
  // beside it, labeled as such. That is exactly the doctrine this codebase already applies to
  // `decision.reason` on the approval path: "UNTRUSTED, so it is sanitized and carried in refs,
  // NOT the verified summary… labeled + quoted + quarantined so the owner sees WHY without the
  // card becoming a persuasion/injection surface."
  //
  // Consequences, all improvements: there is no bypass class left to find, because there is no
  // verification claim to defeat; and 100% of rationales reach the owner instead of 94-99%,
  // because suppression only ever existed to protect the claim we no longer make.
  //
  // SANITIZED (Gate-② security finding M-01): model prose can carry injected content from a memo
  // or inbound delegation, and `sanitizeAgentIntent` is the function this codebase already uses
  // for that. 400 code points rather than the 160 default, since a rationale is one or two
  // sentences and the schema caps it at 600. The AUDIT record keeps the raw string — sanitize for
  // presentation, preserve for audit.
  const rationale =
    typeof detail['rationale'] === 'string' && detail['rationale'] !== ''
      ? (sanitizeAgentIntent(detail['rationale'], 400) ?? undefined)
      : undefined;
  // Recorded as a QUALITY SIGNAL for evals/monitoring, never as a display gate. `rationaleAnchored`
  // keeps its value as a measurable metric (the probe scores it, and a drop is worth alerting on);
  // it simply no longer decides whether the owner may read the agent's own words.
  const rationaleAgrees = detail['rationaleAnchored'] === true ? true : undefined;
  // P3C-6(ii): decoded contract errors ride the live frame too — the cockpit
  // shows plain language without waiting for a /traces refetch.
  const decoded = detail['decoded'];
  return {
    type: 'trace',
    kind: rec.kind,
    seq: rec.seq,
    ts: rec.ts,
    summary: summarize(rec, detail),
    ...(to !== undefined ? { to } : {}),
    ...(valueWei !== undefined ? { valueWei } : {}),
    ...(txHash !== undefined ? { txHash } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(rationale !== undefined ? { rationale } : {}),
    ...(rationaleAgrees !== undefined ? { rationaleAgrees } : {}),
    ...(decoded !== undefined && decoded !== null ? { decoded } : {}),
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
