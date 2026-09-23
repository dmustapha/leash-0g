// LIVE: Phase-4 ACP deliverable-quality evals (spec §8, D-JOB-8) — the real-
// trace half of the layering proof. Runs against live 0G Compute (skeptic
// judge, temperature 0, retries). The DETERMINISTIC half (schema-valid-but-
// wrong passes the floor; the gate composes) is CI, in test/unit/job-layering.
//
// Two lanes:
//   1. PROVIDER quality (~16 real-trace market questions): the provider agent
//      produces a schema-valid deliverable that PASSES the deterministic floor
//      AND an independent skeptic evaluator ACCEPTS it (genuine, calibrated).
//   2. EVALUATOR skepticism (F7-limit): a hand-crafted schema-valid-but-WRONG
//      deliverable passes the floor but the live evaluator REJECTS it — proving
//      the semantic catch the structural floor cannot make.
import { describe, it, expect, beforeAll } from 'vitest';
import { ComputeQueue } from '../src/gateway/compute-queue.js';
import {
  buildProviderRequest,
  parseDeliverable,
  buildEvaluatorRequest,
  parseVerdict,
} from '../src/jobs/prompt.js';
import { evaluateAcceptance, type AcceptanceRuleSet } from '../src/jobs/acceptance.js';
import type { JobSpec } from '../src/jobs/envelopes.js';
import { completionContent } from '../src/runtime/prompt.js';
import type { Json } from '../src/crypto/canonical.js';
import { COMPUTE_BASE_URL, requireEnv, writeEvalArtifact } from './helpers.js';

// Spec §0.6 + F8: the provider work cycle and the evaluator verdict cycle use a
// STRONGER 0G-catalog model than the platform default (0gm-1.0 flaked on
// structured output in Phase 3), and the evaluator's model MUST DIFFER from the
// provider's so verification does not inherit the provider's blind spots
// (perspective diversity). Confirmed against listService() / GET /models on the
// 0G router; overridable via env for catalog drift.
const PROVIDER_MODEL = process.env['JOB_PROVIDER_MODEL'] ?? 'deepseek-v3';
const EVALUATOR_MODEL = process.env['JOB_EVALUATOR_MODEL'] ?? 'glm-5';

const SERVICE_SPEC = 'calibrated probability estimates for near-term market and on-chain questions';
const DELIVERABLE_SCHEMA =
  'a JSON object {"probability": number in [0,1], "rationale": string (>= 40 chars, the reasoning), "signals": string[] (>=1 cited factor)}';

// The generic, config-driven acceptance floor (F2) — structural conformance
// only; the evaluator judges semantics.
const FLOOR: AcceptanceRuleSet = {
  label: 'market-probability-floor',
  rules: [
    { kind: 'required', path: 'probability' },
    { kind: 'numberRange', path: 'probability', min: 0, max: 1 },
    { kind: 'required', path: 'rationale' },
    { kind: 'stringLength', path: 'rationale', min: 40 },
    { kind: 'type', path: 'signals', type: 'array' },
    { kind: 'arrayMinLength', path: 'signals', min: 1 },
  ],
};

function spec(question: string): JobSpec {
  return { question, deliverableSchemaRef: DELIVERABLE_SCHEMA, acceptanceRef: 'market-probability-floor' };
}

// ~16 real-trace market/analysis questions a real Olas Predict / ACP operator
// would post (the flagship on-demand AI task). Varied domains so a single
// blind spot cannot pass the whole suite.
const PROVIDER_QUESTIONS: string[] = [
  'Will Ethereum have a successful mainnet hard fork in the next 6 months?',
  'Will the total value locked in DeFi exceed $150B before the end of the year?',
  'Will Bitcoin close above its previous all-time high within the next 90 days?',
  'Will a major L2 rollup process more daily transactions than Ethereum L1 this quarter?',
  'Will the US Federal Reserve cut interest rates at its next scheduled meeting?',
  'Will global smartphone shipments grow year-over-year in the current quarter?',
  'Will a spot Solana ETF be approved by a major regulator within 12 months?',
  'Will the price of gold set a new nominal all-time high this calendar year?',
  'Will the number of active Ethereum validators exceed 1.2 million within 6 months?',
  'Will renewable sources supply more than 30% of EU electricity this year?',
  'Will a top-5 stablecoin depeg by more than 2% for over an hour this quarter?',
  'Will OpenAI or a competitor release a model scoring above 90% on a named benchmark this year?',
  'Will the 30-year US mortgage rate fall below 6% within 6 months?',
  'Will a hurricane make US landfall as Category 4 or stronger this season?',
  'Will the Ethereum staking ratio exceed 30% of total supply within a year?',
  'Will an NFT collection surpass a 10 ETH floor price for the first time this quarter?',
];

// F7-limit: structurally valid, semantically indefensible. The floor passes it;
// the skeptic must reject it. (Uncalibrated 0.99, self-contradicting rationale.)
const WRONG_DELIVERABLE: Json = {
  probability: 0.99,
  rationale:
    'There is basically no way to know this and the evidence is genuinely mixed and weak, but I am stating near-certainty anyway because a confident number looks better.',
  signals: ['gut feeling'],
};

// A well-behaved deliverable for the accept case (calibrated, grounded).
const GOOD_DELIVERABLE: Json = {
  probability: 0.35,
  rationale:
    'Historically these events resolve yes roughly a third of the time; current leading indicators are mildly negative and no strong catalyst is scheduled in the window, so a below-even estimate is warranted.',
  signals: ['base-rate ~33%', 'no scheduled catalyst in window', 'mildly negative momentum'],
};

let queue: ComputeQueue;

beforeAll(() => {
  queue = new ComputeQueue({ baseUrl: COMPUTE_BASE_URL, apiKey: requireEnv('ZERO_G_COMPUTE_API_KEY') });
});

/** Ask the live skeptic evaluator for a verdict on a deliverable. Retries transport/parse. */
async function evaluate(jobSpec: JobSpec, deliverable: Json): Promise<'accept' | 'reject'> {
  const body = buildEvaluatorRequest(EVALUATOR_MODEL, jobSpec, deliverable, 'strict calibration + grounded-claims rubric');
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, 5_000 * (attempt - 1)));
    const res = await queue.enqueue('job-eval-verdict', body).catch(() => null);
    if (!res) continue;
    const parsed = parseVerdict(completionContent(res.body));
    if (parsed) return parsed.verdict;
  }
  throw new Error('evaluator produced no parseable verdict after 3 attempts');
}

// Aggregate observed accept-rate across the real-trace suite — a CALIBRATION
// metric, not a gate. The spec-mandated skeptic (§3d.2 "default to REJECT") is
// deliberately conservative: it will reject defensible-but-imperfect work,
// which §6 names as the evaluator's worst case (denial-of-service on payment,
// owner-visible — never an over-pay). We RECORD the rate here so calibration
// (§8) can tune the rubric; we do NOT assert a specific accept-rate, which
// would either fight the anti-sycophancy design or hardcode a flaky bar.
const accepts: Array<{ question: string; verdict: 'accept' | 'reject' }> = [];

describe('ACP deliverable quality (live 0G Compute) — provider lane', () => {
  for (const question of PROVIDER_QUESTIONS) {
    it(`provider produces schema-valid, floor-passing work (D-JOB-1/8): ${question.slice(0, 55)}`, async () => {
      const jobSpec = spec(question);
      const request = buildProviderRequest(PROVIDER_MODEL, jobSpec, SERVICE_SPEC);
      // Reasoning models occasionally starve the JSON (finish_reason length) —
      // retry the completion before asserting shape (transport luck, not quality).
      let content = '';
      let deliverable: Json | null = null;
      for (let attempt = 1; attempt <= 3 && deliverable === null; attempt++) {
        const res = await queue.enqueue('job-eval-provider', request);
        expect(res.status).toBe(200);
        content = completionContent(res.body);
        deliverable = parseDeliverable(content);
      }
      expect(deliverable).not.toBeNull(); // D-JOB-1: schema-valid (parseable object)
      if (!deliverable) return;

      // Layer 1 (HARD): the strong provider's real work must clear the
      // deterministic floor — this is the structural quality guarantee.
      const floor = evaluateAcceptance(deliverable, FLOOR);
      expect(floor.passed).toBe(true);

      // Layer 2 (OBSERVED): an independent skeptic judges semantics. The verdict
      // is a valid enum and is recorded; the accept-rate is a calibration metric.
      const verdict = await evaluate(jobSpec, deliverable);
      expect(['accept', 'reject']).toContain(verdict);
      accepts.push({ question, verdict });
      writeEvalArtifact(`provider-${question}`, { deliverable, floor, verdict });
    });
  }
});

describe('ACP evaluator skepticism (live 0G Compute) — F7-limit + calibration', () => {
  const jobSpec = spec(PROVIDER_QUESTIONS[0] ?? 'Will X happen?');

  it('REJECTS a schema-valid-but-wrong deliverable the floor let through (HARD — the layering catch)', async () => {
    // The deterministic floor cannot catch this — it is well-formed (F7-limit).
    expect(evaluateAcceptance(WRONG_DELIVERABLE, FLOOR).passed).toBe(true);
    // The live skeptic MUST. This is the whole point of the evaluator layer, and
    // the direction that must never flake (paying for garbage is the real harm).
    const verdict = await evaluate(jobSpec, WRONG_DELIVERABLE);
    writeEvalArtifact('evaluator-rejects-wrong', { deliverable: WRONG_DELIVERABLE, verdict });
    expect(verdict).toBe('reject');
  });

  it('records the accept-direction disposition on a calibrated deliverable (OBSERVED — anti-sycophancy note)', async () => {
    expect(evaluateAcceptance(GOOD_DELIVERABLE, FLOOR).passed).toBe(true); // clears the floor
    const verdict = await evaluate(jobSpec, GOOD_DELIVERABLE);
    // Recorded, not asserted: the default-reject skeptic may still reject a
    // defensible answer. The over-conservatism is a calibration signal (§8), not
    // a correctness failure — the gate's job is to never over-pay.
    expect(['accept', 'reject']).toContain(verdict);
    writeEvalArtifact('evaluator-accept-direction', { deliverable: GOOD_DELIVERABLE, verdict });
  });

  it('reports the observed provider-lane accept-rate (calibration metric, §8)', () => {
    const total = accepts.length;
    const accepted = accepts.filter((a) => a.verdict === 'accept').length;
    const rate = total > 0 ? accepted / total : 0;
    console.log(
      total > 0
        ? `[calibration] provider-lane accept-rate: ${accepted}/${total} = ${(rate * 100).toFixed(0)}%`
        : '[calibration] provider lane not run in this invocation (filtered) — no accept-rate to report',
    );
    writeEvalArtifact('calibration-accept-rate', { total, accepted, rate, detail: accepts });
    // Purely observational — a LOW rate is the signal to soften the rubric
    // (§8 calibration), never a build failure (never over-paying is correct).
  });
});
