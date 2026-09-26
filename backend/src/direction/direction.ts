// File: backend/src/direction/direction.ts
// Phase-5.5 spine (1): direction-time elevation. Turn an owner's plain-language
// re-direction of a RUNNING agent into a QUARANTINED DirectionDraft — the agent's
// own read-back of the new task. Reuses the Phase-5 elevation posture verbatim:
//   • Quarantine (F4/F5, 00 §6b): WRITES NOTHING. The route persists only a
//     `draft` directions row; authority is written solely by the owner's confirm.
//   • Never-guess-money (S21, D-5): the draft NEVER contains a recipient/allowlist
//     address, settlement token, or a fee (unless the owner's own words stated an
//     explicit base-units amount). Cap suggestions are SHOWN, never armed — a
//     loosen rides the on-chain timelocked propose/apply, not this path.
//   • Generality guard (R-1/D-15): `goalPatch` is filtered to the role's
//     DESCRIPTIVE fields and dry-run-validated through applyGoalPatch, so the
//     draft is already in-union; the role never changes via chat.
//   • R-2: `moneyPower` is SERVER-COMPUTED from the agent's real role, never
//     model-authored — a hallucinating model cannot mislabel a spender.

import { z } from 'zod';
import type { ComputeQueue } from '../gateway/compute-queue.js';
import { type AgentGoal, type AgentRole, goalRole } from '../types.js';
import { completionText, extractJson, feeFromIntent, moneyPowerOf, suggestedPolicySchema, type SuggestedPolicy } from '../create/elevation.js';
import { ruleSchema, type AcceptanceRule } from '../jobs/acceptance.js';
import { applyGoalPatch, DESCRIPTIVE_FIELDS, type GoalPatch } from './goal-schema.js';

/**
 * The QUARANTINED direction read-back (a suggestion; NOT authority until confirm).
 * No address/token field exists on the type — never-guess-money is structural.
 * `moneyPower` is server-computed (R-2).
 */
export interface DirectionDraft {
  agentId: string;
  currentRole: AgentRole;
  understanding: string;
  goalPatch: GoalPatch;
  acceptancePatch?: AcceptanceRule[];
  suggestedPolicy?: SuggestedPolicy;
  suggestedFeeBaseUnits?: string;
  moneyPower: 'can-move-money' | 'cannot-move-money';
  unsureFields: string[];
  confidence: 'high' | 'low';
}

export interface DirectRequest {
  agentId: string;
  currentGoal: AgentGoal;
  capabilityLabel?: string | null;
  intent: string;
  answers?: string[];
}

/**
 * What we ask the MODEL for (non-strict → hallucinated address/fee/token keys are
 * DROPPED, never trusted). No money/address fields appear here at all.
 */
const modelDirectionSchema = z.object({
  understanding: z.string().min(1).max(2000),
  goalPatch: z.record(z.unknown()).optional(),
  acceptancePatch: z.array(ruleSchema).max(64).optional(),
  suggestedPolicy: suggestedPolicySchema.optional(),
  unsureFields: z.array(z.string().max(80)).max(20).optional(),
  confidence: z.enum(['high', 'low']).optional(),
});

export interface DirectionDeps {
  queue: ComputeQueue;
  model: string;
  maxRetries?: number;
}

const SYSTEM_PROMPT = `You are LEASH's direction assistant. An owner is re-directing an AI agent that is ALREADY RUNNING, in plain language. Turn their instruction into a DRAFT the owner will review, edit, and confirm before it takes effect. You do NOT change what the agent is allowed to do — only WHAT it is trying to do, within its existing shape.

Output STRICT JSON only (no prose, no markdown fences). Shape:
{
  "understanding": one short plain-language sentence: how you understand the new task,
  "goalPatch": an object with ONLY the descriptive fields you are changing (see the allowed fields below) — omit it if nothing descriptive changes,
  "acceptancePatch": (ONLY if the owner is changing what a job must satisfy) an array of structural acceptance rules,
  "suggestedPolicy": (ONLY if the owner asked to change spending limits) {"perTransferCapWei","windowCapWei","windowSeconds"} as strings — this is a SUGGESTION the owner must apply separately; it is never armed here,
  "unsureFields": array of field names you were unsure about,
  "confidence": "high" or "low"
}

HARD RULES:
- NEVER output any wallet address, recipient, allowlist, settlement token, or a specific fee amount. Those are handled by the owner separately. Do not invent them.
- NEVER change the agent's role/type. Only propose changes to the allowed descriptive fields.
- If the instruction does not map to any allowed descriptive field, return an empty goalPatch and set confidence "low".
- Keep it minimal and faithful to what the owner actually said.`;

function buildUserMessage(req: DirectRequest): string {
  const role = goalRole(req.currentGoal);
  const allowed = DESCRIPTIVE_FIELDS[role];
  const current: Record<string, unknown> = {};
  for (const f of allowed) current[f] = (req.currentGoal as unknown as Record<string, unknown>)[f];
  const parts = [
    `Agent role: ${role}${req.capabilityLabel ? ` (labelled: ${req.capabilityLabel})` : ''}.`,
    `Allowed descriptive fields you may change: ${allowed.length ? allowed.join(', ') : '(none — this role has no chat-editable descriptive fields)'}.`,
    `Their current values: ${JSON.stringify(current)}.`,
    `Owner instruction: ${req.intent.trim()}`,
  ];
  if (req.answers && req.answers.length > 0) {
    parts.push(`Extra answers: ${req.answers.map((a) => a.trim()).filter(Boolean).join(' | ')}`);
  }
  return parts.join('\n');
}

/** Keep only the descriptive keys for this role — model noise is dropped at draft time (R-1 hard-rejects at confirm). */
function pickDescriptive(role: AgentRole, patch: Record<string, unknown> | undefined): GoalPatch {
  if (!patch) return {};
  const allowed = DESCRIPTIVE_FIELDS[role];
  const out: GoalPatch = {};
  for (const k of allowed) {
    if (k in patch && patch[k] !== undefined) out[k] = patch[k] as GoalPatch[string];
  }
  return out;
}

/**
 * A deterministic SAFE fallback (never throws, never a half-draft): a no-op
 * directive that changes NOTHING, low confidence, so a failed/garbled elevation
 * can never corrupt the running goal. The owner rephrases or edits.
 */
export function safeFallback(req: DirectRequest): DirectionDraft {
  return {
    agentId: req.agentId,
    currentRole: goalRole(req.currentGoal),
    understanding: 'We could not auto-interpret this instruction. Nothing has changed. Please rephrase or edit the fields directly.',
    goalPatch: {},
    moneyPower: moneyPowerOf(goalRole(req.currentGoal)),
    unsureFields: ['intent'],
    confidence: 'low',
  };
}

function toDraft(model: z.infer<typeof modelDirectionSchema>, req: DirectRequest): DirectionDraft {
  const role = goalRole(req.currentGoal);
  const goalPatch = pickDescriptive(role, model.goalPatch);
  // Dry-run the generality guard so the DRAFT is already union-valid (D-15). A
  // patch that cannot merge cleanly collapses to a no-op suggestion.
  const applied = applyGoalPatch(req.currentGoal, goalPatch);
  const safePatch = applied.ok ? goalPatch : {};
  // The model proposed changes that ALL fell outside the role's descriptive
  // surface (e.g. a role change / a money field) — the owner's instruction did
  // not map to anything we can safely apply, so this is a low-confidence no-op.
  const droppedAll = !!model.goalPatch && Object.keys(model.goalPatch).length > 0 && Object.keys(safePatch).length === 0;
  const fee = role === 'requester' ? feeFromIntent(req.intent) : undefined;
  const draft: DirectionDraft = {
    agentId: req.agentId,
    currentRole: role,
    understanding: model.understanding,
    goalPatch: safePatch,
    moneyPower: moneyPowerOf(role), // R-2: server-computed, never trusted from the model
    unsureFields: model.unsureFields ?? [],
    confidence: applied.ok && !droppedAll ? (model.confidence ?? 'low') : 'low',
    ...(model.acceptancePatch ? { acceptancePatch: model.acceptancePatch } : {}),
    ...(model.suggestedPolicy ? { suggestedPolicy: model.suggestedPolicy } : {}),
    ...(fee ? { suggestedFeeBaseUnits: fee } : {}),
  };
  return draft;
}

/**
 * Elevate a running-agent re-direction → a quarantined DirectionDraft. Bounded
 * retry on shape failure, then a deterministic safe no-op fallback. WRITES NOTHING.
 */
export async function elevateDirection(deps: DirectionDeps, req: DirectRequest): Promise<DirectionDraft> {
  const maxRetries = deps.maxRetries ?? 1;
  const body = {
    model: deps.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserMessage(req) },
    ],
    temperature: 0.2,
    max_tokens: 1500,
  };
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await deps.queue.enqueue(`direct:${attempt}`, body);
      if (res.status >= 200 && res.status < 300) {
        const parsed = extractJson(completionText(res.body));
        const model = modelDirectionSchema.safeParse(parsed);
        if (model.success) {
          return toDraft(model.data, req);
        }
      }
    } catch {
      /* network/timeout — retry, then fall back */
    }
  }
  return safeFallback(req);
}
