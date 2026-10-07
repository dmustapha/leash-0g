import type { Pool } from 'pg';
import type { SseHub } from '../sse/hub.js';
import type { ApprovalBroker } from '../approvals/broker.js';
import type { AlertService } from '../alerts/service.js';
import type { AgentRow } from '../types.js';
import type { Json } from '../crypto/canonical.js';
import { approvalEvent, traceEvent } from '../sse/events.js';
import { appendTrace } from '../trace/trace-store.js';
import { createApproval, decideApproval, getApproval } from '../store/approvals.js';
import { sanitizeStatusAnswer } from '../direction/status.js';
import { inMinutes } from '../util/format.js';
import { computeToolCallHash, type ToolRegistry } from './index.js';
import type { ToolGateResult } from '../gateway/mcp/tool-gate.js';
import {
  insertToolRequest,
  setToolRequestApproval,
  setToolRequestDecision,
  upsertToolRule,
  recordToolPresetApplied,
  type ToolRequestRow,
} from '../store/tools.js';

/**
 * SF-3 tool-use service — the OFF-CHAIN JIT rail for governed tool calls, the
 * tool analogue of `capabilities/service.ts`. A tool call the gate classified L2
 * (a policy edge, or a sensitive tool that ALWAYS asks — 00 §6c) is raised as a
 * QUARANTINED request on the EXISTING approval/consent rail (approve-once /
 * always-allow / deny) rather than being executed. The quarantined intent is
 * labeled UNVERIFIED, sanitized, and NEVER forwarded until the owner consents —
 * and a tool RESULT can never mutate the allowlist (only an owner always-allow
 * writes a standing `tool_rule`, §8 tool-chaining escalation).
 */

export interface ToolServiceDeps {
  pool: Pool;
  hub: SseHub;
  broker: ApprovalBroker;
  alerts: AlertService;
  registry: ToolRegistry;
  /** how long a JIT tool card stays actionable before auto-expiry (ms). */
  jitTtlMs: number;
}

export interface RaiseToolResult {
  request: ToolRequestRow;
  created: boolean;
}

/**
 * Raise a quarantined JIT request for an L2 tool call. Idempotent on the exact
 * (tool, args) bytes via the call hash: an identical pending request is reused
 * (never a duplicate card). Rides the existing approval rail so the card is
 * surfaced on the cockpit + Telegram, auto-expires, and resolves on any channel.
 */
export async function raiseToolRequest(
  deps: ToolServiceDeps,
  agent: AgentRow,
  gate: ToolGateResult,
): Promise<RaiseToolResult> {
  if (gate.classification.lane !== 'l2') {
    throw new Error(`raiseToolRequest called with a non-L2 classification: ${gate.classification.lane}`);
  }
  const triggers = gate.classification.triggers;
  const callHash = computeToolCallHash(agent.chainId, gate.toolId, gate.guardedArgs);

  // The quarantined, sanitized, inert intent — display + audit only. The args to
  // forward live in their own column (server-held guarded bytes), never executed
  // until consent. M-01: the summary is composed from STRUCTURED facts (tool id +
  // trigger names), never the agent-authored arg content, so nothing attacker-
  // influenceable rides the owner's Telegram (00 §6b).
  const decoded: Json = {
    label: 'UNVERIFIED',
    toolId: gate.toolId,
    server: gate.descriptor?.server ?? null,
    triggers,
  };

  const { row, created } = await insertToolRequest(deps.pool, {
    agentId: agent.id,
    ownerAddr: agent.ownerAddr,
    toolId: gate.toolId,
    decoded,
    triggers,
    callHash,
    args: gate.guardedArgs,
  });
  if (!created && row.approvalId) return { request: row, created: false };

  const approval = await createApproval(deps.pool, agent.id, {
    type: 'tool',
    requestId: row.id,
    callHash,
  });
  await setToolRequestApproval(deps.pool, row.id, approval.id);

  const why = triggers.includes('sensitive')
    ? 'it is a sensitive tool (sends/writes/spends) and those always ask you first'
    : `it is outside the policy you set (${triggers.join(', ')})`;
  const summary = sanitizeStatusAnswer(
    `${agent.name} wants to use the "${gate.toolId}" tool but ${why}. Approve it (once or always) in the app.`,
  );
  deps.hub.emit(agent.id, 'approval', approvalEvent({ approvalId: approval.id, summary }));
  await deps.alerts.emit(agent.ownerAddr, {
    agentId: agent.id,
    class: 'decision',
    kind: 'tool_request',
    summary: `${summary} ⏱ Expires ${inMinutes(deps.jitTtlMs)} if you don't answer.`,
    refs: { approvalId: approval.id, toolRequestId: row.id },
    dedupKey: `tool_request:${row.id}`,
  });

  return { request: { ...row, approvalId: approval.id }, created };
}

export type ToolJitDecision = 'approve_once' | 'always_allow' | 'deny';

export type DecideToolResult =
  | { ok: true; status: ToolRequestRow['status'] }
  | { ok: false; reason: 'already_decided' | 'no_approval' | 'agent_mismatch' };

/**
 * Owner decision on a JIT tool request. Mirrors `decideCapabilityRequest` but is
 * fully OFF-CHAIN (no tx): the consent IS the authority for this call.
 *
 * - `approve_once` → let THIS held call through; no standing grant.
 * - `always_allow` → also write a standing `tool_rule` so future identical calls
 *   are L1 — EXCEPT a SENSITIVE tool stays always-ask (00 §6c): the standing rule
 *   keeps `sensitive:true`, so the classifier still returns L2 next time. An owner
 *   can never blanket-suppress a sensitive tool.
 * - `deny`  → refuse; nothing granted.
 */
export async function decideToolRequest(
  deps: ToolServiceDeps,
  agent: AgentRow,
  request: ToolRequestRow,
  decision: ToolJitDecision,
  opts: { channel?: 'app' | 'telegram' } = {},
): Promise<DecideToolResult> {
  // C-SF3-2 (defense-in-depth): the caller resolves `agent` and `request`
  // separately; never decide a request that belongs to a different agent, even
  // if a route forgets the upstream check. Fail closed before any state write.
  if (request.agentId !== agent.id) return { ok: false, reason: 'agent_mismatch' };
  if (!request.approvalId) return { ok: false, reason: 'no_approval' };

  const status = decision === 'approve_once' ? 'approved_once' : decision === 'always_allow' ? 'always_allowed' : 'denied';
  // C-SF3-5: setToolRequestDecision is a CAS on status='pending'. This closes the
  // decide↔timeout race: if the synchronous JIT hold already expired the request
  // (status='expired') the owner's late decision loses the CAS → already_decided,
  // and crucially no second forward happens (the held call already failed closed
  // on timeout). First writer wins; a stale decision can never re-open a call.
  const decided = await setToolRequestDecision(deps.pool, request.id, status);
  if (!decided) return { ok: false, reason: 'already_decided' };

  const approval = await getApproval(deps.pool, request.approvalId);
  if (approval && approval.state === 'pending') {
    const consentDecision = decision === 'deny' ? 'deny' : 'approve';
    await decideApproval(deps.pool, approval.id, consentDecision);
    const consent = await appendTrace(deps.pool, {
      agentId: agent.id,
      kind: 'consent',
      approvalId: approval.id,
      decision: consentDecision,
      decidedBy: 'owner',
      originalRequest: request.decoded,
      detail: { channel: opts.channel ?? 'app', jitDecision: decision, toolId: request.toolId },
    });
    deps.hub.emit(agent.id, 'trace', traceEvent(consent));
    // Wake the held gateway tool call (synchronous JIT hold in the governed
    // provider) — consent is already durable above, so forwarding is safe.
    deps.broker.notify(approval.id, { decision: consentDecision });
    deps.hub.emit(agent.id, 'approval_decided', {
      type: 'approval_decided',
      approvalId: approval.id,
      decision: consentDecision,
    });
    await deps.alerts.resolveByApproval(approval.id, {
      resolution: consentDecision,
      via: opts.channel ?? 'app',
      agentId: agent.id,
      consentSeq: consent.seq,
    });
  }

  if (decision === 'always_allow') {
    const descriptor = deps.registry.get(request.toolId);
    await upsertToolRule(deps.pool, {
      agentId: agent.id,
      ownerAddr: agent.ownerAddr,
      rule: {
        toolId: request.toolId,
        allowed: true,
        // sensitive tools can never be blanket-suppressed (00 §6c).
        sensitive: descriptor?.sensitive ?? false,
      },
      source: 'jit',
      status: 'active',
    });
  }

  return { ok: true, status: decided.status };
}

// ---------------------------------------------------------------------------
// Preset recording (display) — after the owner applied a tool preset.
// ---------------------------------------------------------------------------

export async function recordToolPresetGrants(
  pool: Pool,
  agent: AgentRow,
  presetKey: string,
  rules: { toolId: string; allowed: boolean; sensitive: boolean }[],
): Promise<void> {
  await recordToolPresetApplied(pool, agent.id, agent.ownerAddr, presetKey);
  for (const rule of rules) {
    await upsertToolRule(pool, {
      agentId: agent.id,
      ownerAddr: agent.ownerAddr,
      rule: { toolId: rule.toolId, allowed: rule.allowed, sensitive: rule.sensitive },
      source: `preset:${presetKey}`,
      status: 'active',
    });
  }
}
