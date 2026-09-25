// File: backend/src/create/elevation.ts
// Phase-5 Stage B (D-B1/B2/B4) — spec-elevation: turn a non-technical owner's
// rough intent into a QUARANTINED draft agent spec, on 0G Compute (LEASH's key,
// not agent-keyed). The draft is a SUGGESTION ONLY — it is never persisted as
// authority; the owner confirms it on the read-back, which reuses the existing
// create path. Two load-bearing invariants live here:
//   • Quarantine (F4/F5, 00 §6b): this module WRITES NOTHING. It returns a draft
//     the owner edits + confirms. The route asserts no DB write on /elevate.
//   • Never-guess-money (spec §8): the draft NEVER contains a recipient/allowlist
//     address (a hallucinated address is a real hazard the model can't know), and
//     NEVER pre-fills a fee unless the user's own words stated an explicit amount.
//     The role's money-power is translated to plain language so a wrong-role draft
//     (a spender where the user wanted a watcher) is human-catchable.
// The output is authored ROLE-NEUTRAL (a "here's what I understood, edit, confirm"
// unit) so Phase 5.5 can reuse the same shape at direction-time (spec §9).

import { z } from 'zod';
import type { ComputeQueue } from '../gateway/compute-queue.js';
import type { AgentRole } from '../types.js';
import { ruleSchema } from '../jobs/acceptance.js';

const ROLES = ['treasury', 'sentinel', 'executor', 'requester', 'provider', 'evaluator'] as const;
const weiSchema = z.string().regex(/^[0-9]{1,30}$/);

/** Roles that can move funds (native or ERC-20). Everything else is spend-incapable. */
export function moneyPowerOf(role: AgentRole): 'can-move-money' | 'cannot-move-money' {
  return role === 'treasury' || role === 'executor' || role === 'requester'
    ? 'can-move-money'
    : 'cannot-move-money';
}

/** Caps elevation may SUGGEST (native). Expiry stays an owner create-time choice. */
export const suggestedPolicySchema = z
  .object({ perTransferCapWei: weiSchema, windowCapWei: weiSchema, windowSeconds: z.number().int().positive() })
  .strict();
export type SuggestedPolicy = z.infer<typeof suggestedPolicySchema>;

export const elevationJobSpecSchema = z
  .object({
    fields: z
      .object({
        question: z.string().min(1).max(8000),
        context: z.string().max(8000).optional(),
        deliverableSchemaRef: z.string().min(1).max(200),
        acceptanceRef: z.string().min(1).max(200),
      })
      .strict(),
    acceptance: z.array(ruleSchema).max(64),
  })
  .strict();

/**
 * The QUARANTINED suggestion object. Strict — this is the shape the route returns
 * and the read-back renders. It deliberately has NO recipient/allowlist address
 * field and NO settlement-token address field: those are blank-required in the UI
 * (never-guess-money). `moneyPower` is a plain-language translation of the role.
 */
export const elevationDraftSchema = z
  .object({
    proposedRole: z.enum(ROLES),
    rationale: z.string().min(1).max(2000),
    capabilityLabel: z.string().max(120).optional(),
    jobSpec: elevationJobSpecSchema.optional(),
    serviceSpec: z.string().max(2000).optional(),
    rubricRef: z.string().max(400).optional(),
    suggestedPolicy: suggestedPolicySchema.optional(),
    suggestedTokenPerTransferWei: weiSchema.optional(),
    suggestedTokenWindowWei: weiSchema.optional(),
    // ONLY set when the user's intent stated an explicit base-units amount; never guessed.
    suggestedFeeBaseUnits: weiSchema.optional(),
    moneyPower: z.enum(['can-move-money', 'cannot-move-money']),
    unsureFields: z.array(z.string().max(80)).max(20),
    confidence: z.enum(['high', 'low']),
  })
  .strict();
export type ElevationDraft = z.infer<typeof elevationDraftSchema>;

export interface ElevateRequest {
  intent: string;
  answers?: string[];
  role?: AgentRole;
}

/**
 * What we ask the MODEL for (non-strict → unknown keys are DROPPED by zod, which
 * is exactly what we want: a hallucinated `feeRecipient`/`settlementToken`/`fee`
 * key is silently discarded rather than trusted). NO money/address fields appear
 * here at all, so the model is never even asked to produce one.
 */
const modelDraftSchema = z.object({
  proposedRole: z.enum(ROLES),
  rationale: z.string().min(1).max(2000),
  capabilityLabel: z.string().max(120).optional(),
  jobSpec: elevationJobSpecSchema.optional(),
  serviceSpec: z.string().max(2000).optional(),
  rubricRef: z.string().max(400).optional(),
  suggestedPolicy: suggestedPolicySchema.optional(),
  suggestedTokenPerTransferWei: weiSchema.optional(),
  suggestedTokenWindowWei: weiSchema.optional(),
  unsureFields: z.array(z.string().max(80)).max(20).optional(),
  confidence: z.enum(['high', 'low']).optional(),
});

export interface ElevationDeps {
  queue: ComputeQueue;
  model: string;
  maxRetries?: number;
}

const SYSTEM_PROMPT = `You are LEASH's create assistant. A non-technical user describes, in plain language, an on-chain AI agent they want. Turn their description into a DRAFT spec they will review and edit.

Output STRICT JSON only (no prose, no markdown fences). Shape:
{
  "proposedRole": one of "treasury"|"sentinel"|"executor"|"requester"|"provider"|"evaluator",
  "rationale": one short plain-language sentence: what you understood they want,
  "capabilityLabel": a 2-4 word label for what the agent is for (e.g. "market forecaster"),
  "jobSpec": (ONLY for a "requester") { "fields": {"question","context"?,"deliverableSchemaRef","acceptanceRef"}, "acceptance": [structural rules] },
  "serviceSpec": (ONLY for a "provider") a short description of the service it offers,
  "rubricRef": (ONLY for an "evaluator") a short description of the standard it judges by,
  "suggestedPolicy": (ONLY for "treasury"|"executor", which move native funds) {"perTransferCapWei","windowCapWei","windowSeconds"} — CONSERVATIVE caps in wei as strings,
  "suggestedTokenPerTransferWei","suggestedTokenWindowWei": (ONLY for "requester") conservative token base-unit caps as strings,
  "unsureFields": array of field names you were not confident about,
  "confidence": "high" or "low"
}

Role meanings:
- treasury: watches a wallet and tops it up itself (moves native funds).
- sentinel: watches and only ASKS another agent to pay (never moves money).
- executor: acts on requests from a linked agent, within its own caps (moves native funds).
- requester: orders a defined job and pays a capped ERC-20 fee for verified work.
- provider: does jobs and delivers a verifiable work-product (never moves money).
- evaluator: judges others' work as a skeptic (never moves money).

CRITICAL RULES:
- NEVER output any wallet address, recipient, allowlist, settlement token address, or a specific fee amount. Those are set by the user later. Do not invent them.
- Prefer the SAFEST role that fits. If the user only wants to watch/monitor, choose "sentinel" or "provider", never a spender.
- Keep caps conservative. When unsure about a field, list it in unsureFields and set confidence "low".`;

function buildUserMessage(req: ElevateRequest): string {
  const parts = [`User intent: ${req.intent.trim()}`];
  if (req.role) parts.push(`The user picked this role: ${req.role}. Use it unless it is clearly wrong.`);
  if (req.answers && req.answers.length > 0) {
    parts.push(`Extra answers the user gave: ${req.answers.map((a) => a.trim()).filter(Boolean).join(' | ')}`);
  }
  return parts.join('\n');
}

/** Pull the assistant text out of an OpenAI-shaped chat completion (or reasoning models). */
function completionText(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const msg = (choices[0] as { message?: { content?: unknown; reasoning_content?: unknown } }).message;
  const content = typeof msg?.content === 'string' ? msg.content : '';
  if (content.trim()) return content;
  // Reasoning models (0gm-1.0) may starve content; fall back to reasoning_content.
  return typeof msg?.reasoning_content === 'string' ? msg.reasoning_content : '';
}

/** Extract the first JSON object from model text (tolerates stray prose / fences). */
function extractJson(text: string): unknown {
  const fenced = text.replace(/```(?:json)?/gi, '');
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(fenced.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Only prefill a fee when the user's OWN words stated an explicit base-units
 * integer (e.g. "fee 5000000 base units"). A fuzzy "5 USDC" is NOT converted —
 * the token's decimals are unknown at create time, so guessing would be exactly
 * the money-guess the spec forbids. Almost always returns undefined by design;
 * the read-back leaves the fee blank-required (spec §8, D-B4).
 */
export function feeFromIntent(intent: string): string | undefined {
  const m = /(\d[\d,]{0,29})\s*base\s*units/i.exec(intent);
  if (!m || !m[1]) return undefined;
  const digits = m[1].replace(/,/g, '');
  return /^[0-9]{1,30}$/.test(digits) ? digits : undefined;
}

/**
 * A deterministic SAFE fallback (D-B1) used when the model call fails or its
 * output can't be validated after retries. Never throws, never a half-draft: a
 * spend-incapable "provider" whose service is the raw intent — a valid, editable,
 * low-confidence agent the owner completes on the read-back.
 */
export function safeFallback(req: ElevateRequest): ElevationDraft {
  const role: AgentRole = req.role ?? 'provider';
  const label = req.intent.trim().split(/\s+/).slice(0, 4).join(' ').slice(0, 120) || 'my agent';
  const draft: ElevationDraft = {
    proposedRole: role,
    rationale: `We could not auto-draft this. Here is a safe starting point from what you typed — please review and edit every field.`,
    capabilityLabel: label,
    moneyPower: moneyPowerOf(role),
    unsureFields: ['proposedRole'],
    confidence: 'low',
  };
  if (role === 'provider') draft.serviceSpec = req.intent.trim().slice(0, 2000);
  if (role === 'evaluator') draft.rubricRef = req.intent.trim().slice(0, 400);
  return draft;
}

/**
 * Build the RETURNED draft from validated model output. This is where the
 * never-guess-money invariant is enforced structurally: no address/token field is
 * ever carried (the model schema has none), the fee is set ONLY from the user's
 * stated amount, and moneyPower is derived from the role (not trusted from the
 * model) so the read-back can warn on a wrong-role draft.
 */
function toDraft(model: z.infer<typeof modelDraftSchema>, req: ElevateRequest): ElevationDraft {
  const role = model.proposedRole;
  const fee = role === 'requester' ? feeFromIntent(req.intent) : undefined;
  const draft: ElevationDraft = {
    proposedRole: role,
    rationale: model.rationale,
    moneyPower: moneyPowerOf(role),
    unsureFields: model.unsureFields ?? [],
    confidence: model.confidence ?? 'low',
    ...(model.capabilityLabel ? { capabilityLabel: model.capabilityLabel } : {}),
    ...(model.jobSpec ? { jobSpec: model.jobSpec } : {}),
    ...(model.serviceSpec ? { serviceSpec: model.serviceSpec } : {}),
    ...(model.rubricRef ? { rubricRef: model.rubricRef } : {}),
    ...(model.suggestedPolicy ? { suggestedPolicy: model.suggestedPolicy } : {}),
    ...(model.suggestedTokenPerTransferWei ? { suggestedTokenPerTransferWei: model.suggestedTokenPerTransferWei } : {}),
    ...(model.suggestedTokenWindowWei ? { suggestedTokenWindowWei: model.suggestedTokenWindowWei } : {}),
    ...(fee ? { suggestedFeeBaseUnits: fee } : {}),
  };
  // Final strict validation of OUR shape (D-B1): the returned draft is always a
  // strict-Zod-valid ElevationDraft or we fall back.
  return elevationDraftSchema.parse(draft);
}

/**
 * Elevate rough intent → a quarantined ElevationDraft. Bounded retry on
 * shape failure, then a deterministic safe fallback. WRITES NOTHING.
 */
export async function elevateIntent(deps: ElevationDeps, req: ElevateRequest): Promise<ElevationDraft> {
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
      const res = await deps.queue.enqueue(`elevate:${attempt}`, body);
      if (res.status >= 200 && res.status < 300) {
        const parsed = extractJson(completionText(res.body));
        const model = modelDraftSchema.safeParse(parsed);
        if (model.success) {
          try {
            return toDraft(model.data, req);
          } catch {
            /* our strict re-validation failed — retry, then fall back */
          }
        }
      }
    } catch {
      /* network/timeout — retry, then fall back */
    }
  }
  return safeFallback(req);
}
