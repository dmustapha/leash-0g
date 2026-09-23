import { describe, it, expect } from 'vitest';
import { evaluateAcceptance, type AcceptanceRuleSet } from '../../src/jobs/acceptance.js';
import { evaluateGate } from '../../src/jobs/gate.js';
import type { Json } from '../../src/crypto/canonical.js';

/**
 * The layering-proof (spec §8, F7-limit) — the DETERMINISTIC, first-try-green
 * half of the deliverable-quality evals (P4C-4). It nails the honest limit
 * stated in §3d.1: the acceptance floor is a STRUCTURAL conformance check, NOT
 * a semantic quality judge. A schema-valid-but-WRONG deliverable therefore
 * sails through the floor and MUST be caught by the next layer (the skeptic
 * evaluator). This proves the three layers are genuinely independent
 * (D-JOB-3) without any LLM in the loop — the live deliverable-quality eval
 * (test-live/job-evals.live.test.ts) exercises the evaluator model itself.
 */

// The same generic market-analysis floor the requester runs (F2 — not
// prediction-specific; a structural rule set keyed off the job spec).
const FLOOR: AcceptanceRuleSet = {
  label: 'market-analysis-floor',
  rules: [
    { kind: 'required', path: 'probability' },
    { kind: 'numberRange', path: 'probability', min: 0, max: 1 },
    { kind: 'required', path: 'rationale' },
    { kind: 'stringLength', path: 'rationale', min: 1 },
    { kind: 'type', path: 'signals', type: 'array' },
    { kind: 'arrayMinLength', path: 'signals', min: 1 },
  ],
};

// Structurally impeccable, semantically worthless: a well-formed probability
// with a rationale that does not actually support the number, and a citation
// list that is present but vacuous. Every FLOOR rule is satisfied.
const SCHEMA_VALID_BUT_WRONG: Json = {
  probability: 0.5,
  rationale: 'it could go either way, so fifty-fifty feels safe',
  signals: ['vibes'],
};

// A deliverable that fails the floor outright (probability out of range +
// missing signals) — the floor blocks this with no evaluator ever consulted.
const MALFORMED: Json = { probability: 9.9, rationale: '' };

describe('layered gate — the acceptance floor is structural-only (F7-limit)', () => {
  it('a schema-valid-but-semantically-wrong deliverable PASSES the deterministic floor', () => {
    const result = evaluateAcceptance(SCHEMA_VALID_BUT_WRONG, FLOOR);
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.checked).toBe(FLOOR.rules.length);
  });

  it('the floor still blocks a structurally malformed deliverable (layer 1 has teeth)', () => {
    const result = evaluateAcceptance(MALFORMED, FLOOR);
    expect(result.passed).toBe(false);
    // out-of-range probability + wrong-type/absent signals + empty rationale.
    expect(result.failures.length).toBeGreaterThanOrEqual(3);
  });

  it('floor-passing garbage is caught downstream: evaluator reject blocks release', () => {
    const acceptance = evaluateAcceptance(SCHEMA_VALID_BUT_WRONG, FLOOR);
    expect(acceptance.passed).toBe(true); // layer 1 let it through (structural)
    // layer 2 (the skeptic) is where wrong-but-well-formed work dies.
    const gate = evaluateGate({ acceptance, verdict: 'reject', owner: 'pending' });
    expect(gate.release).toBe(false);
    expect(gate.blockedBy).toBe('verdict');
  });

  it('even an accepting evaluator cannot release without the owner (layer 3)', () => {
    const acceptance = evaluateAcceptance(SCHEMA_VALID_BUT_WRONG, FLOOR);
    const pending = evaluateGate({ acceptance, verdict: 'accept', owner: 'pending' });
    expect(pending.release).toBe(false);
    expect(pending.blockedBy).toBe('owner');
    const denied = evaluateGate({ acceptance, verdict: 'accept', owner: 'deny' });
    expect(denied.release).toBe(false);
    expect(denied.blockedBy).toBe('owner');
  });

  it('all three layers passing is the ONLY path to release', () => {
    const acceptance = evaluateAcceptance(SCHEMA_VALID_BUT_WRONG, FLOOR);
    const released = evaluateGate({ acceptance, verdict: 'accept', owner: 'approve' });
    expect(released.release).toBe(true);
    expect(released.blockedBy).toBeUndefined();
  });
});
