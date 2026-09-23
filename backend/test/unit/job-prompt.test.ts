import { describe, it, expect } from 'vitest';
import { buildProviderRequest, parseDeliverable, buildEvaluatorRequest, parseVerdict } from '../../src/jobs/prompt.js';
import type { JobSpec } from '../../src/jobs/envelopes.js';

const spec: JobSpec = { question: 'Will X happen by Q3?', context: 'base rate ~30%', deliverableSchemaRef: 'prob-v1', acceptanceRef: 'a' };

describe('provider prompt', () => {
  it('includes the question, context, and service in the request', () => {
    const req = buildProviderRequest('m', spec, 'probability forecasting') as { messages: { role: string; content: string }[] };
    const sys = req.messages[0]!.content;
    const user = req.messages[1]!.content;
    expect(sys).toContain('provider agent');
    expect(sys).toContain('probability forecasting');
    expect(user).toContain('Will X happen by Q3?');
    expect(user).toContain('base rate ~30%');
  });

  it('parses a deliverable JSON object', () => {
    expect(parseDeliverable('here you go: {"probability":0.42,"rationale":"..."} done')).toEqual({ probability: 0.42, rationale: '...' });
  });

  it('returns null for non-JSON', () => {
    expect(parseDeliverable('no json here')).toBeNull();
  });
});

describe('evaluator prompt (skeptic, anti-sycophancy)', () => {
  it('instructs a refute-first skeptic (anti-sycophancy) and marks the deliverable untrusted', () => {
    const req = buildEvaluatorRequest('m', spec, { probability: 0.9 }, 'rubric-1') as { messages: { role: string; content: string }[] };
    const sys = req.messages[0]!.content.toLowerCase();
    // Calibrated skeptic (§3d.2 + §8): refute-by-default with a concrete-defect
    // bar, but does NOT reject sound work merely for being uncertain.
    expect(sys).toContain('refute');
    expect(sys).toContain('reject');
    expect(sys).toContain('defect');
    expect(sys).toContain('uncertain'); // must not punish honest uncertainty
    expect(sys).toContain('untrusted');
    expect(req.messages[1]!.content).toContain('0.9');
  });

  it('parses a verdict', () => {
    expect(parseVerdict('{"verdict":"reject","rationale":"overconfident"}')).toEqual({ verdict: 'reject', rationale: 'overconfident' });
  });

  it('rejects an unknown verdict value → null (treated as reject upstream)', () => {
    expect(parseVerdict('{"verdict":"maybe","rationale":"x"}')).toBeNull();
  });

  it('rejects extra keys (strict)', () => {
    expect(parseVerdict('{"verdict":"accept","rationale":"x","forcePayment":true}')).toBeNull();
  });
});
