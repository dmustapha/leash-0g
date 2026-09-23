import { describe, it, expect } from 'vitest';
import { evaluateAcceptance, acceptanceRuleSetSchema, type AcceptanceRuleSet } from '../../src/jobs/acceptance.js';

// The deterministic acceptance FLOOR (F2): a GENERIC rule engine, not a
// prediction-specific validator. Structural conformance only — semantic
// quality is the evaluator's job (the honest limit, spec §3d.1).

const probRuleSet: AcceptanceRuleSet = {
  label: 'probability deliverable v1',
  rules: [
    { kind: 'required', path: 'probability' },
    { kind: 'numberRange', path: 'probability', min: 0, max: 1 },
    { kind: 'required', path: 'rationale' },
    { kind: 'stringLength', path: 'rationale', min: 20 },
    { kind: 'arrayMinLength', path: 'signals', min: 1 },
    { kind: 'enum', path: 'stance', values: ['yes', 'no', 'uncertain'] },
  ],
};

describe('evaluateAcceptance (generic rule engine, F2)', () => {
  it('passes a well-formed deliverable', () => {
    const r = evaluateAcceptance(
      { probability: 0.62, rationale: 'A calibrated estimate based on the cited base rates.', signals: ['a'], stance: 'yes' },
      probRuleSet,
    );
    expect(r.passed).toBe(true);
    expect(r.failures).toEqual([]);
    expect(r.checked).toBe(6);
  });

  it('reports ALL failures, not just the first', () => {
    const r = evaluateAcceptance({ probability: 1.5, rationale: 'short', signals: [], stance: 'maybe' }, probRuleSet);
    expect(r.passed).toBe(false);
    expect(r.failures.length).toBeGreaterThanOrEqual(4); // range, length, array, enum
  });

  it('catches a missing required field', () => {
    const r = evaluateAcceptance({ rationale: 'x'.repeat(30), signals: ['s'], stance: 'no' }, probRuleSet);
    expect(r.passed).toBe(false);
    expect(r.failures.some((f) => f.includes('probability'))).toBe(true);
  });

  it('a garbage deliverable (wrong types) fails the floor', () => {
    const r = evaluateAcceptance({ probability: 'high', rationale: 42, signals: 'nope', stance: 5 }, probRuleSet);
    expect(r.passed).toBe(false);
  });

  it('HONEST LIMIT: a schema-valid but semantically WRONG deliverable PASSES the floor', () => {
    // Absurd probability (0.999 for a coin flip) with a plausible-looking
    // rationale — structurally perfect. The floor cannot catch this; the
    // evaluator + evals must (the layering proof, F7-limit).
    const r = evaluateAcceptance(
      { probability: 0.999, rationale: 'The coin will certainly land heads because reasons.', signals: ['vibes'], stance: 'yes' },
      probRuleSet,
    );
    expect(r.passed).toBe(true);
  });

  it('resolves nested + array paths', () => {
    const rs: AcceptanceRuleSet = { rules: [{ kind: 'type', path: 'meta.items.0.name', type: 'string' }] };
    expect(evaluateAcceptance({ meta: { items: [{ name: 'ok' }] } }, rs).passed).toBe(true);
    expect(evaluateAcceptance({ meta: { items: [{ name: 5 }] } }, rs).passed).toBe(false);
  });

  it('the rule set schema is strict', () => {
    expect(acceptanceRuleSetSchema.safeParse({ rules: [{ kind: 'required', path: 'x', extra: 1 }] }).success).toBe(false);
    expect(acceptanceRuleSetSchema.safeParse({ rules: [] }).success).toBe(false);
  });
});
