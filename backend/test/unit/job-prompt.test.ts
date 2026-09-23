import { describe, it, expect } from 'vitest';
import { buildProviderRequest, parseDeliverable, buildEvaluatorRequest, parseVerdict } from '../../src/jobs/prompt.js';
import { renderAcceptanceContract } from '../../src/jobs/acceptance.js';
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

  it('D-JOB-10: injects the acceptance field contract so the model emits the required top-level fields', () => {
    // The exact rule set that made the live provider fail (nested {analysis}
    // instead of top-level probability/rationale).
    const contract = renderAcceptanceContract({
      label: 'market-analysis-floor',
      rules: [
        { kind: 'required', path: 'probability' },
        { kind: 'numberRange', path: 'probability', min: 0, max: 1 },
        { kind: 'required', path: 'rationale' },
        { kind: 'stringLength', path: 'rationale', min: 1 },
      ],
    });
    // the rendered contract names the fields, types, and range
    expect(contract).toContain('"probability"');
    expect(contract).toContain('"rationale"');
    expect(contract).toContain('>= 0');
    expect(contract).toContain('<= 1');
    expect(contract).toContain('do not nest them under a wrapper object');

    const req = buildProviderRequest('m', spec, 'probability forecasting', contract) as {
      messages: { role: string; content: string }[];
    };
    const user = req.messages[1]!.content;
    expect(user).toContain('"probability"');
    expect(user).toContain('"rationale"');
    // and without a contract, the prompt still works (backward compatible)
    const bare = buildProviderRequest('m', spec, 'svc') as { messages: { content: string }[] };
    expect(bare.messages[1]!.content).not.toContain('"probability"');
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
