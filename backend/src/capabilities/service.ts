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
import {
  computeCallHash,
  expandPreset,
  type CallRule,
  type CapabilityPreset,
  type Novelty,
  type PresetKey,
  type TargetCatalog,
} from '../governed-call/index.js';
import type { GateResult } from '../gateway/call-gate.js';
import {
  insertCapabilityRequest,
  setRequestApproval,
  setRequestDecision,
  upsertGrant,
  recordPresetApplied,
  type RequestRow,
} from '../store/capabilities.js';

/**
 * Stage D capability service (spec §3b). The OFF-CHAIN layer around the on-chain
 * grant grammar: preset resolution (broad-grant UX, D-9) + the L2 JIT rail (D-8).
 *
 * Signing-locus (honesty, spec §1e/D-8): the backend NEVER holds owner authority
 * and NEVER submits a grant tx. A grant that changes on-chain state (always-allow
 * → proposeCallRule; approve-once → authorizeOnce; a preset → a batch of
 * proposeCallRule) is signed IN-APP by the Privy owner wallet — the same path as
 * proposePolicy/proposeAllowlist since Phase 1. This service RESOLVES the exact
 * rule params (from server-side catalog state, never model text — never-guess-
 * money) and RECORDS the read-model + JIT workflow; the FE signs and reports the
 * tx hash back. A novel call is impossible until that owner on-chain tx lands.
 */

export interface CapabilityDeps {
  pool: Pool;
  hub: SseHub;
  broker: ApprovalBroker;
  alerts: AlertService;
  /** how long a JIT card stays actionable before it auto-expires (ms). */
  jitTtlMs: number;
}

// ---------------------------------------------------------------------------
// Preset resolution (D-9) — pure; never touches model text or the chain.
// ---------------------------------------------------------------------------

export type ResolvePresetResult =
  | { ok: true; preset: CapabilityPreset }
  | { ok: false; reason: 'unknown_preset' | 'unresolvable_target' };

/**
 * Resolve a preset to the concrete grant proposals the owner must sign. Returns
 * a typed failure (never a partial grant) when a referenced target/token is
 * missing from the network catalog (`expandPreset` returns null).
 */
export function resolvePreset(key: PresetKey, catalog: TargetCatalog): ResolvePresetResult {
  const preset = expandPreset(key, catalog);
  if (!preset) return { ok: false, reason: 'unresolvable_target' };
  return { ok: true, preset };
}

/**
 * Record the read-model for an applied preset AFTER the owner signed the batch
 * of proposeCallRule txs client-side. Display only — the on-chain account is
 * authoritative; these rows render the envelope + "runs DeFi Trader" chip.
 */
export async function recordPresetGrants(
  pool: Pool,
  agent: AgentRow,
  preset: CapabilityPreset,
  txHash?: string,
): Promise<void> {
  await recordPresetApplied(pool, agent.id, agent.ownerAddr, preset.key);
  for (const rule of preset.rules) {
    await upsertGrant(pool, {
      agentId: agent.id,
      ownerAddr: agent.ownerAddr,
      rule,
      source: `preset:${preset.key}`,
      status: 'proposed',
      txHash,
    });
  }
}

// ---------------------------------------------------------------------------
// The L2 JIT rail (D-8).
// ---------------------------------------------------------------------------

export interface RaiseResult {
  request: RequestRow;
  /** true when this call raised a NEW request (false = an identical pending one already existed). */
  created: boolean;
}

/**
 * Raise a quarantined capability request for a NOVEL governed call (D-8). The
 * runtime calls this when the off-chain gate classified the intended call as L2
 * (novel) — instead of a doomed on-chain submit (P3C-6). Idempotent on the exact
 * call bytes: an identical pending request is reused (never a duplicate card).
 *
 * The decoded intent is QUARANTINED (labeled UNVERIFIED, sanitized, refs-only —
 * the Phase-3 pattern) and NEVER executed; it is display + audit only.
 */
export async function raiseCapabilityRequest(
  deps: CapabilityDeps,
  agent: AgentRow,
  gate: GateResult,
): Promise<RaiseResult> {
  if (gate.classification.lane !== 'l2') {
    throw new Error(`raiseCapabilityRequest called with a non-L2 classification: ${gate.classification.lane}`);
  }
  const novelty: Novelty[] = gate.classification.novelty;
  const d = gate.decoded;
  const callHash = computeCallHash(agent.chainId, d.target, d.value, d.data);

  // Quarantined, sanitized, inert intent — the on-chain wall never trusts this.
  const decoded: Json = {
    label: 'UNVERIFIED',
    target: d.target.toLowerCase(),
    selector: d.selector.toLowerCase(),
    signature: d.signature,
    value: d.value.toString(),
    humanReadable: sanitizeStatusAnswer(d.humanReadable),
    novelty,
  };

  const { row, created } = await insertCapabilityRequest(deps.pool, {
    agentId: agent.id,
    ownerAddr: agent.ownerAddr,
    decoded,
    novelty,
    callHash,
    // SE-2: persist the exact refused bytes so a later approve-once can auto-retry
    // + consume the on-chain one-shot. These are server-authored (buildGovernedCall,
    // never model text) and bound by callHash — the owner authorizes THAT hash.
    callTarget: d.target,
    callValue: d.value.toString(),
    callData: d.data,
  });
  // Repair-forward (W2, code-review 2026-09-28): a reused row that already has
  // its approval bound is a true no-op. But a reused row with NO approval bound
  // is a crash remnant (a prior cycle died between insertCapabilityRequest and
  // setRequestApproval) — left as-is it's stuck pending forever
  // (decideCapabilityRequest → no_approval) until TTL. Fall through to bind +
  // surface it. This is idempotent: the insert/reuse already de-duped the row,
  // so at most one unbound row can exist, and it gets exactly one card here.
  if (!created && row.approvalId) return { request: row, created: false };

  // Ride the EXISTING approval/consent rail so the JIT card is surfaced,
  // auto-expires with the sweep, and resolves on any channel.
  const approval = await createApproval(deps.pool, agent.id, {
    type: 'capability',
    requestId: row.id,
    callHash,
  });
  await setRequestApproval(deps.pool, row.id, approval.id);

  const summary = sanitizeStatusAnswer(
    `${agent.name} wants to make a new on-chain call it isn't yet allowed to: ${d.humanReadable}. ` +
      `Review and grant it (once or always) in the app — it stays put until you decide.`,
  );
  deps.hub.emit(agent.id, 'approval', approvalEvent({ approvalId: approval.id, summary }));
  await deps.alerts.emit(agent.ownerAddr, {
    agentId: agent.id,
    class: 'decision',
    kind: 'capability_request',
    summary: `${summary} ⏱ Expires ${inMinutes(deps.jitTtlMs)} if you don't answer.`,
    refs: { approvalId: approval.id, capabilityRequestId: row.id },
    dedupKey: `capability_request:${row.id}`,
  });

  return { request: { ...row, approvalId: approval.id }, created };
}

export type JitDecision = 'approve_once' | 'always_allow' | 'deny';

export type DecideCapabilityResult =
  | { ok: true; status: RequestRow['status'] }
  | { ok: false; reason: 'already_decided' | 'missing_tx' | 'missing_rule' | 'no_approval' };

/**
 * Owner decision on a JIT request. The grant tx (authorizeOnce for approve-once,
 * proposeCallRule for always-allow) is signed CLIENT-SIDE by the owner wallet;
 * this records the decision + consent + read-model sync AFTER the tx.
 *
 * Ordering mirrors the shared consent path (decide.ts): decide the approval
 * once (idempotent), append the durable consent record with the QUARANTINED
 * original intent, THEN notify the broker (consent-seq < any action). There is
 * no delegation to activate — a capability decision only widens the on-chain
 * envelope (or stands down).
 */
export async function decideCapabilityRequest(
  deps: CapabilityDeps,
  agent: AgentRow,
  request: RequestRow,
  decision: JitDecision,
  opts: { txHash?: string | undefined; rule?: CallRule | undefined; channel?: 'app' | 'telegram' },
): Promise<DecideCapabilityResult> {
  if (decision !== 'deny' && !opts.txHash) return { ok: false, reason: 'missing_tx' };
  if (decision === 'always_allow' && !opts.rule) return { ok: false, reason: 'missing_rule' };
  if (!request.approvalId) return { ok: false, reason: 'no_approval' };

  const status = decision === 'approve_once' ? 'approved_once' : decision === 'always_allow' ? 'always_allowed' : 'denied';

  // Decide the request row exactly once (idempotent — a double-tap can't double-grant).
  const decidedReq = await setRequestDecision(deps.pool, request.id, status, opts.txHash);
  if (!decidedReq) return { ok: false, reason: 'already_decided' };

  // Consent bookkeeping on the shared rail (approval → consent → notify).
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
      originalRequest: request.decoded, // the QUARANTINED decoded intent (audit only)
      detail: {
        channel: opts.channel ?? 'app',
        jitDecision: decision,
        ...(opts.txHash !== undefined ? { txHash: opts.txHash } : {}),
      },
    });
    deps.hub.emit(agent.id, 'trace', traceEvent(consent));
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

  // always-allow persists a standing read-model grant (source 'jit'); approve-once
  // is a one-shot and grants NO standing rule (the on-chain authorizeOnce is
  // consumed on first use — nothing to display as a persistent grant).
  if (decision === 'always_allow' && opts.rule) {
    await upsertGrant(deps.pool, {
      agentId: agent.id,
      ownerAddr: agent.ownerAddr,
      rule: opts.rule,
      source: 'jit',
      status: 'proposed',
      txHash: opts.txHash,
    });
  }

  return { ok: true, status: decidedReq.status };
}
