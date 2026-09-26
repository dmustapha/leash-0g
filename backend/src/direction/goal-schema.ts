// File: backend/src/direction/goal-schema.ts
// Phase-5.5 R-1 (BINDING, security spine): the generality guard enforced at the
// AUTHORITY-WRITE boundary, server-side — not only at draft time.
//
// A conversational directive elevates ONLY into the EXISTING generic goal union
// (types.ts AgentGoal) and the EXISTING AcceptanceRule union (jobs/acceptance.ts
// ruleSchema). This module is the single place that decides whether a proposed
// `goalPatch` / `acceptancePatch` may merge into an agent's live goal. It is
// called at BOTH the owner's confirm AND the runtime `sense_direction` apply, so
// a prompt-injected out-of-union patch that the owner confirms by trusting a
// plausible read-back STILL cannot merge (D-15 tests the draft; R-1 tests here).
//
// Three invariants, enforced structurally:
//   1. NO role change via chat (generality guard, 00 §2/§5b, S21): the merged
//      goal's role MUST equal the current role. `type` is never patchable.
//   2. NO out-of-union goal shape: the merged goal MUST strict-parse against the
//      live goal union — no per-vertical field, no new goal shape.
//   3. NEVER-GUESS-MONEY (D-5, S21): a patch may only touch DESCRIPTIVE fields
//      (behaviour/intent), never money-authority fields (recipient/allowlist
//      address, settlement token, fee amount, or a delegation binding). Any key
//      outside the per-role descriptive whitelist is REJECTED (not silently
//      dropped) so an injected `feeRecipient` patch is a hard, visible failure.
// An address change (e.g. re-target a treasury's beneficiary) is owner-typed and
// out-of-band on confirm (mirrors Phase-5 recipient discipline) — see applyRecipient.

import { z } from 'zod';
import type { Json } from '../crypto/canonical.js';
import { type AgentGoal, type AgentRole, goalRole } from '../types.js';
import { ruleSchema, type AcceptanceRule } from '../jobs/acceptance.js';

const weiSchema = z.string().regex(/^[0-9]{1,30}$/);
const addrSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const modelSchema = z.string().min(1).max(120).optional();

/**
 * Zod mirror of the AgentGoal union in types.ts (kept in lockstep — a new goal
 * role must be added here too, deliberately, so chat direction never becomes the
 * back door for an unvalidated shape). Each variant is STRICT: an unknown key is
 * a parse failure, so a merged goal carrying a smuggled field is rejected.
 */
const treasuryGoalSchema = z
  .object({
    type: z.literal('treasury').optional(),
    beneficiary: addrSchema,
    targetBalanceWei: weiSchema,
    topUpWei: weiSchema,
    model: modelSchema,
  })
  .strict();
const sentinelGoalSchema = z
  .object({
    type: z.literal('sentinel'),
    beneficiary: addrSchema,
    targetBalanceWei: weiSchema,
    topUpWei: weiSchema,
    model: modelSchema,
  })
  .strict();
const executorGoalSchema = z.object({ type: z.literal('executor'), model: modelSchema }).strict();
const requesterGoalSchema = z
  .object({
    type: z.literal('requester'),
    jobSpecSource: z.string().min(1),
    providerAgentId: z.string().min(1),
    evaluatorAgentId: z.string().min(1),
    feeToken: addrSchema,
    feeRecipient: addrSchema,
    feeCapPerJobWei: weiSchema,
    model: modelSchema,
  })
  .strict();
const providerGoalSchema = z.object({ type: z.literal('provider'), serviceSpec: z.string().min(1).max(2000), model: modelSchema }).strict();
const evaluatorGoalSchema = z.object({ type: z.literal('evaluator'), rubricRef: z.string().min(1).max(400), model: modelSchema }).strict();

/**
 * The live goal union. Each variant is strict + role-specific, so a well-formed
 * goal matches exactly one — including a Phase-1 treasury row with no `type`.
 */
export const goalSchema: z.ZodType<AgentGoal> = z.union([
  treasuryGoalSchema,
  sentinelGoalSchema,
  executorGoalSchema,
  requesterGoalSchema,
  providerGoalSchema,
  evaluatorGoalSchema,
]) as z.ZodType<AgentGoal>;

/**
 * Per-role DESCRIPTIVE (chat-patchable) fields. Deliberately excludes:
 *  - `type` (role) — no role change via chat (invariant 1).
 *  - `model` — runtime config, not conversational intent.
 *  - every money-authority field: `beneficiary`/`feeRecipient` (addresses →
 *    owner-typed out-of-band, applyRecipient), `feeToken` (settlement token),
 *    `feeCapPerJobWei` (a spend ceiling → PolicyPanel timelocked loosen),
 *    `jobSpecSource`/`providerAgentId`/`evaluatorAgentId` (authority bindings).
 * The result is a narrow, honest patch surface: what a treasury/sentinel watches
 * for (thresholds), what a provider offers, what an evaluator judges by.
 */
export const DESCRIPTIVE_FIELDS: Record<AgentRole, readonly string[]> = {
  treasury: ['targetBalanceWei', 'topUpWei'],
  sentinel: ['targetBalanceWei', 'topUpWei'],
  executor: [],
  requester: [],
  provider: ['serviceSpec'],
  evaluator: ['rubricRef'],
};

export type GoalPatch = Record<string, Json>;

export type ApplyGoalPatchResult =
  | { ok: true; goal: AgentGoal }
  | { ok: false; reason: string };

/**
 * R-1 enforcement point. Merge a proposed descriptive `goalPatch` into the
 * agent's CURRENT goal and return the new goal ONLY if all three invariants
 * hold. Called at confirm AND at sense_direction apply.
 */
export function applyGoalPatch(currentGoal: AgentGoal, patch: GoalPatch | undefined): ApplyGoalPatchResult {
  const role = goalRole(currentGoal);
  const allowed = DESCRIPTIVE_FIELDS[role];
  const patchKeys = patch ? Object.keys(patch) : [];

  // Invariant 3 (+ 1): reject a patch that names ANY non-descriptive field —
  // `type` (role change) or a money-authority key are hard, visible failures,
  // never silently dropped.
  const illegal = patchKeys.filter((k) => !allowed.includes(k));
  if (illegal.length > 0) {
    return { ok: false, reason: `patch touches non-descriptive field(s): ${illegal.join(', ')}` };
  }
  if (patchKeys.length === 0) {
    // A no-op patch is valid (the directive changed nothing descriptive — e.g. a
    // pure re-target via recipient, or a low-confidence safe fallback).
    return { ok: true, goal: currentGoal };
  }

  const merged = { ...(currentGoal as unknown as Record<string, Json>), ...patch };
  const parsed = goalSchema.safeParse(merged);
  if (!parsed.success) {
    return { ok: false, reason: `merged goal is not in the goal union: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
  }
  // Invariant 1: role is immutable across a chat directive.
  if (goalRole(parsed.data) !== role) {
    return { ok: false, reason: 'a directive cannot change the agent role' };
  }
  return { ok: true, goal: parsed.data };
}

/**
 * R-1 at the runtime APPLY boundary (sense_direction): re-validate the
 * owner-confirmed EFFECTIVE goal — a full goal, not a patch — against the live
 * union AND assert the role is unchanged, before it is written to agents.goal.
 * Defence-in-depth: confirm already validated, but the authority write happens
 * here, so a tampered/stale effective goal still cannot merge out-of-union.
 */
export function revalidateEffectiveGoal(currentGoal: AgentGoal, effective: unknown): ApplyGoalPatchResult {
  const parsed = goalSchema.safeParse(effective);
  if (!parsed.success) {
    return { ok: false, reason: `effective goal is not in the goal union: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
  }
  if (goalRole(parsed.data) !== goalRole(currentGoal)) {
    return { ok: false, reason: 'effective goal changes the agent role' };
  }
  return { ok: true, goal: parsed.data };
}

export type ValidateAcceptanceResult =
  | { ok: true; rules: AcceptanceRule[] }
  | { ok: false; reason: string };

/**
 * R-1 for acceptance: an `acceptancePatch` must be an array of rules from the
 * EXISTING AcceptanceRule union (ruleSchema) — reject anything out-of-union.
 */
export function validateAcceptancePatch(rules: unknown): ValidateAcceptanceResult {
  const parsed = z.array(ruleSchema).min(1).max(64).safeParse(rules);
  if (!parsed.success) {
    return { ok: false, reason: `acceptance rules are not in the acceptance union: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
  }
  return { ok: true, rules: parsed.data };
}

/**
 * Owner-typed, OUT-OF-BAND address re-target (never model-authored — mirrors the
 * Phase-5 recipient discipline). Applies only to the role's single address field
 * (beneficiary for treasury/sentinel, feeRecipient for requester). Returns the
 * goal unchanged when no recipient is supplied. The on-chain allowlist still
 * bounds any resulting send (defence in depth): a wrong address simply cannot
 * receive.
 */
export function applyRecipient(goal: AgentGoal, recipient: string | undefined): ApplyGoalPatchResult {
  if (recipient === undefined || recipient === '') return { ok: true, goal };
  if (!addrSchema.safeParse(recipient).success) {
    return { ok: false, reason: 'recipient is not a valid address' };
  }
  const role = goalRole(goal);
  const lower = recipient.toLowerCase();
  if (role === 'treasury' || role === 'sentinel') {
    return { ok: true, goal: { ...(goal as object), beneficiary: lower } as AgentGoal };
  }
  if (role === 'requester') {
    return { ok: true, goal: { ...(goal as object), feeRecipient: lower } as AgentGoal };
  }
  // Spend-incapable roles have no address to re-target — a supplied recipient is a mistake.
  return { ok: false, reason: `role ${role} has no recipient to set` };
}
