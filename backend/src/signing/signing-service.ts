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
  insertSigningRequest,
  setSigningRequestApproval,
  setSigningRequestDecision,
  upsertSigningRule,
  reconcileSigningArms,
  type SigningRequestRow,
} from '../store/signing.js';
import type { SigningRule, SigningTrigger } from './index.js';

/**
 * FP-2 signing service — the OFF-CHAIN JIT rail for governed signing intents, the
 * signing analogue of `tool-use/tool-service.ts`. A signing the engine classified
 * L2 (a sensitive descriptor that ALWAYS asks — 00 §6c) is raised as a QUARANTINED
 * request on the EXISTING approval/consent rail rather than being armed. The
 * quarantined intent is labeled UNVERIFIED (the arm is only real once on-chain),
 * decoded to HUMAN terms (never a raw blob — 00 §9), and never surfaced to the
 * agent as signable until the owner consents. This module also owns the
 * FP-CARRY-4/5 read-model reconcile (a tighten's epoch-bump → in-flight arms stale).
 */

export interface SigningServiceDeps {
  pool: Pool;
  hub: SseHub;
  broker: ApprovalBroker;
  alerts: AlertService;
  /** how long a JIT signing card stays actionable before auto-expiry (ms). */
  jitTtlMs: number;
}

/** The decoded, human-legible payload the JIT card renders + the inert intent to arm on approve. */
export interface RaiseSigningInput {
  descriptorId: number;
  triggers: SigningTrigger[];
  /** keccak of (chainId, descriptorId, spender, amount, deadline) — the one-shot replay key. */
  requestHash: string;
  /** the human-readable decode of EXACTLY what would be signed (00 §9). */
  humanReadable: string;
  protocol: string;
  spender: string;
  amountWei: string;
  deadlineSec: number;
  /** the built typed-data + ordered fields to arm on approve (server-held, inert until consent). */
  intent: Json;
}

export interface RaiseSigningResult {
  request: SigningRequestRow;
  created: boolean;
}

/**
 * Raise a quarantined JIT request for an L2 signing. Idempotent on the exact
 * (descriptor, spender, amount, deadline) via the request hash: an identical
 * pending request is reused (never a duplicate card). Rides the existing approval
 * rail so the card is surfaced on the cockpit + Telegram, auto-expires, and
 * resolves on any channel.
 */
export async function raiseSigningRequest(
  deps: SigningServiceDeps,
  agent: AgentRow,
  input: RaiseSigningInput,
): Promise<RaiseSigningResult> {
  // The quarantined, decoded, inert intent — display + audit. M-01 (mirror SF-3):
  // the summary is composed from STRUCTURED facts (the server-decoded intent),
  // never agent-authored free text, so nothing attacker-influenceable rides the
  // owner's Telegram (00 §6b).
  const decoded: Json = {
    label: 'UNVERIFIED',
    descriptorId: input.descriptorId,
    protocol: input.protocol,
    spender: input.spender,
    amountWei: input.amountWei,
    deadlineSec: input.deadlineSec,
    humanReadable: input.humanReadable,
    triggers: input.triggers,
  };

  const { row, created } = await insertSigningRequest(deps.pool, {
    agentId: agent.id,
    ownerAddr: agent.ownerAddr,
    descriptorId: input.descriptorId,
    decoded,
    triggers: input.triggers,
    requestHash: input.requestHash,
    intent: input.intent,
  });
  if (!created && row.approvalId) return { request: row, created: false };

  const approval = await createApproval(deps.pool, agent.id, {
    type: 'signing',
    requestId: row.id,
    callHash: input.requestHash,
  });
  await setSigningRequestApproval(deps.pool, row.id, approval.id);

  const summary = sanitizeStatusAnswer(
    `${agent.name} wants to sign off-chain: ${input.humanReadable} It is a sensitive signing, so it always asks you first. Approve it (once or always) in the app.`,
  );
  deps.hub.emit(agent.id, 'approval', approvalEvent({ approvalId: approval.id, summary }));
  await deps.alerts.emit(agent.ownerAddr, {
    agentId: agent.id,
    class: 'decision',
    kind: 'signing_request',
    summary: `${summary} ⏱ Expires ${inMinutes(deps.jitTtlMs)} if you don't answer.`,
    refs: { approvalId: approval.id, signingRequestId: row.id },
    dedupKey: `signing_request:${row.id}`,
  });

  return { request: { ...row, approvalId: approval.id }, created };
}

export type SigningJitDecision = 'approve_once' | 'always_allow' | 'deny';

export type DecideSigningResult =
  | { ok: true; status: SigningRequestRow['status'] }
  | { ok: false; reason: 'already_decided' | 'no_approval' | 'agent_mismatch' };

/**
 * Owner decision on a JIT signing request. Mirrors `decideToolRequest` but is the
 * signing analogue: the consent authorizes THIS held sign.
 * - `approve_once` → let the agent arm THIS intent; no standing grant change.
 * - `always_allow` → the owner is fine with this descriptor+spender going forward.
 *   A SENSITIVE descriptor nonetheless STAYS always-ask (00 §6c): `always_allow`
 *   does not suppress the sensitivity, so the next sign still classifies L2. The
 *   engine records the standing grant (`source='jit'`) for the owner's legibility;
 *   it can never blanket-suppress a sensitive descriptor.
 * - `deny` → refuse; nothing armed.
 *
 * NOTE: the ON-CHAIN arm is a session-key tx (the authority). This decision
 * resolves the quarantine + consent record; the actual arm/record happens on the
 * runtime/live-testnet path (FP-3). FP-2 proves the consent rail + read-model.
 */
export async function decideSigningRequest(
  deps: SigningServiceDeps,
  agent: AgentRow,
  request: SigningRequestRow,
  decision: SigningJitDecision,
  grantOnAlways: Pick<SigningRule, 'descriptorId' | 'spenderSet' | 'perIntentCap' | 'maxDeadlineWindow' | 'token'> & {
    descriptorKey: string;
  },
  opts: { channel?: 'app' | 'telegram' } = {},
): Promise<DecideSigningResult> {
  // Defense-in-depth (mirror C-SF3-2): never decide a request that belongs to a
  // different agent, even if a route forgets the upstream check. Fail closed.
  if (request.agentId !== agent.id) return { ok: false, reason: 'agent_mismatch' };
  if (!request.approvalId) return { ok: false, reason: 'no_approval' };

  const status =
    decision === 'approve_once' ? 'approved_once' : decision === 'always_allow' ? 'always_allowed' : 'denied';
  // CAS on status='pending' (closes the decide↔timeout race; first writer wins).
  const decided = await setSigningRequestDecision(deps.pool, request.id, status);
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
      detail: { channel: opts.channel ?? 'app', jitDecision: decision, descriptorId: request.descriptorId },
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

  if (decision === 'always_allow') {
    await upsertSigningRule(deps.pool, {
      agentId: agent.id,
      ownerAddr: agent.ownerAddr,
      descriptorKey: grantOnAlways.descriptorKey,
      rule: {
        descriptorId: grantOnAlways.descriptorId,
        spenderSet: grantOnAlways.spenderSet,
        perIntentCap: grantOnAlways.perIntentCap,
        maxDeadlineWindow: grantOnAlways.maxDeadlineWindow,
        token: grantOnAlways.token,
        active: true,
      },
      source: 'jit',
      status: 'active',
    });
  }

  return { ok: true, status: decided.status };
}

/**
 * FP-CARRY-4/5 read-model reconcile — call after an owner tighten/remove/revoke
 * that bumped the on-chain `signingEpoch`. Marks every in-flight armed intent
 * snapshotting an older epoch 'stale' so the cockpit never shows a dead arm as
 * live. Thin wrapper over the store so routes have one call site.
 */
export async function reconcileAfterEpochBump(
  deps: Pick<SigningServiceDeps, 'pool'>,
  agentId: string,
  currentEpoch: number,
): Promise<number> {
  return reconcileSigningArms(deps.pool, agentId, currentEpoch);
}
