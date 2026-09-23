import { evaluateAcceptance, type AcceptanceRuleSet, type AcceptanceResult } from './acceptance.js';
import type { Json } from '../crypto/canonical.js';

/**
 * The LAYERED verification gate (spec §3d). Settlement releases ONLY when ALL
 * three layers pass, in order:
 *   1. deterministic acceptance FLOOR (pure code, no LLM — F2)
 *   2. evaluator SKEPTIC verdict = accept (anti-sycophancy, ②-B)
 *   3. owner-supervised approval (the 00 §1a decision event)
 * Each layer ALONE blocks release (D-JOB-3). The evaluator verdict is a gate
 * INPUT, never authority — its rationale is untrusted (F-quar). This function
 * is PURE (no IO): the runtime feeds it the three signals and it returns the
 * release decision + which layer blocked (for the trace + cockpit).
 */

export type GateLayer = 'acceptance' | 'verdict' | 'owner';
export type EvaluatorVerdict = 'accept' | 'reject';
export type OwnerDecision = 'approve' | 'deny' | 'pending';

export interface GateInputs {
  acceptance: AcceptanceResult;
  verdict: EvaluatorVerdict;
  owner: OwnerDecision;
}

export interface GateResult {
  /** True ONLY when all three layers pass. */
  release: boolean;
  /** The FIRST layer that blocked (undefined when release === true). */
  blockedBy?: GateLayer;
  reason: string;
}

/** Evaluate the three-layer gate in order; the first failing layer blocks. */
export function evaluateGate(inputs: GateInputs): GateResult {
  if (!inputs.acceptance.passed) {
    return {
      release: false,
      blockedBy: 'acceptance',
      reason: `acceptance floor failed: ${inputs.acceptance.failures.join('; ') || 'malformed deliverable'}`,
    };
  }
  if (inputs.verdict !== 'accept') {
    return { release: false, blockedBy: 'verdict', reason: 'evaluator rejected the deliverable' };
  }
  if (inputs.owner !== 'approve') {
    return {
      release: false,
      blockedBy: 'owner',
      reason: inputs.owner === 'deny' ? 'owner denied the settlement' : 'awaiting owner approval',
    };
  }
  return { release: true, reason: 'all three gate layers passed' };
}

/**
 * Layer 1 helper: run the acceptance floor against a deliverable + rule set.
 * Kept here so the runtime has a single gate entry point. The rule set is
 * resolved from the job spec's `acceptanceRef` (owner-defined registry).
 */
export function runAcceptanceFloor(deliverable: Json | undefined, ruleSet: AcceptanceRuleSet): AcceptanceResult {
  return evaluateAcceptance(deliverable, ruleSet);
}
