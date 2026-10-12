import { describe, it, expect } from 'vitest';
import {
  elevateIntent,
  elevationDraftSchema,
  feeFromIntent,
  moneyPowerOf,
  safeFallback,
  stripAddresses,
  type ElevationDeps,
} from '../../src/create/elevation.js';
import type { ComputeQueue } from '../../src/gateway/compute-queue.js';

/** A ComputeQueue stand-in whose enqueue returns a scripted completion. */
function fakeQueue(reply: () => { status: number; body: unknown }): ComputeQueue {
  return { enqueue: async () => reply() } as unknown as ComputeQueue;
}

function completion(content: unknown): { status: number; body: unknown } {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return { status: 200, body: { choices: [{ message: { content: text } }] } };
}

const deps = (q: ComputeQueue): ElevationDeps => ({ queue: q, model: 'test-model', maxRetries: 1 });

describe('moneyPowerOf', () => {
  it('marks spenders can-move-money and watchers/workers cannot', () => {
    expect(moneyPowerOf('treasury')).toBe('can-move-money');
    expect(moneyPowerOf('executor')).toBe('can-move-money');
    expect(moneyPowerOf('requester')).toBe('can-move-money');
    expect(moneyPowerOf('sentinel')).toBe('cannot-move-money');
    expect(moneyPowerOf('provider')).toBe('cannot-move-money');
    expect(moneyPowerOf('evaluator')).toBe('cannot-move-money');
  });
});

describe('feeFromIntent (never-guess-money)', () => {
  it('returns a fee ONLY when the user stated an explicit base-units integer', () => {
    expect(feeFromIntent('pay 5000000 base units per job')).toBe('5000000');
    expect(feeFromIntent('fee of 1,000,000 base units')).toBe('1000000');
  });
  it('never guesses a fee from a fuzzy amount (unknown decimals)', () => {
    expect(feeFromIntent('pay up to 5 USDC per job')).toBeUndefined();
    expect(feeFromIntent('a small fee')).toBeUndefined();
    expect(feeFromIntent('watch my wallet')).toBeUndefined();
  });
});

describe('safeFallback', () => {
  it('is a valid, spend-incapable, low-confidence draft that never throws', () => {
    const d = safeFallback({ intent: 'summarize research papers for me' });
    expect(() => elevationDraftSchema.parse(d)).not.toThrow();
    expect(d.proposedRole).toBe('provider');
    expect(d.moneyPower).toBe('cannot-move-money');
    expect(d.confidence).toBe('low');
    expect(d.serviceSpec).toContain('summarize');
  });
  it('honours a role hint', () => {
    expect(safeFallback({ intent: 'x', role: 'evaluator' }).proposedRole).toBe('evaluator');
  });
});

describe('elevateIntent', () => {
  it('happy path: valid model output → strict-valid draft with derived money-power', async () => {
    const q = fakeQueue(() =>
      completion({
        proposedRole: 'provider',
        rationale: 'You want an agent that summarizes papers.',
        capabilityLabel: 'research summarizer',
        serviceSpec: 'concise summaries of research papers',
        unsureFields: [],
        confidence: 'high',
      }),
    );
    const d = await elevateIntent(deps(q), { intent: 'summarize research papers' });
    expect(() => elevationDraftSchema.parse(d)).not.toThrow();
    expect(d.proposedRole).toBe('provider');
    expect(d.moneyPower).toBe('cannot-move-money');
    expect(d.serviceSpec).toBe('concise summaries of research papers');
  });

  it('DROPS any hallucinated address/fee keys from model output (never-guess-money)', async () => {
    const q = fakeQueue(() =>
      completion({
        proposedRole: 'requester',
        rationale: 'order a forecast and pay for it',
        capabilityLabel: 'forecast buyer',
        jobSpec: { fields: { question: 'will ETH exceed 4000?', deliverableSchemaRef: 'prob', acceptanceRef: 'floor' }, acceptance: [{ kind: 'required', path: 'probability' }] },
        // hallucinated money fields the model must never be trusted for:
        feeRecipient: '0x' + 'de'.repeat(20),
        settlementToken: '0x' + 'ad'.repeat(20),
        feeBaseUnits: '999999999',
        confidence: 'high',
      }),
    );
    const d = await elevateIntent(deps(q), { intent: 'buy a forecast for me' });
    const serialized = JSON.stringify(d);
    expect(serialized).not.toMatch(/0x[0-9a-f]{40}/i); // no address survived
    expect(d).not.toHaveProperty('feeRecipient');
    expect(d).not.toHaveProperty('settlementToken');
    expect(d.suggestedFeeBaseUnits).toBeUndefined(); // model fee ignored; intent stated none
    expect(d.moneyPower).toBe('can-move-money');
  });

  it('prefills a fee ONLY from the user intent, never the model', async () => {
    const q = fakeQueue(() =>
      completion({ proposedRole: 'requester', rationale: 'r', confidence: 'high' }),
    );
    const d = await elevateIntent(deps(q), { intent: 'buy a forecast, fee 2000000 base units' });
    expect(d.suggestedFeeBaseUnits).toBe('2000000');
  });

  it('malformed model output ⇒ safe fallback (never a throw / half-draft)', async () => {
    const q = fakeQueue(() => completion('not json at all {broken'));
    const d = await elevateIntent(deps(q), { intent: 'watch my wallet and alert me' });
    expect(() => elevationDraftSchema.parse(d)).not.toThrow();
    expect(d.confidence).toBe('low');
    expect(d.proposedRole).toBe('provider'); // fallback
  });

  it('non-2xx from compute ⇒ safe fallback', async () => {
    const q = fakeQueue(() => ({ status: 500, body: { error: 'boom' } }));
    const d = await elevateIntent(deps(q), { intent: 'do a thing', role: 'sentinel' });
    expect(d.proposedRole).toBe('sentinel');
    expect(d.moneyPower).toBe('cannot-move-money');
  });
});

// AB-ELEV root-fix regressions (tear-apart 2026-10-13): the elevation model's
// NATURAL output shape used to fail strict Zod and discard an otherwise-good
// treasury/requester draft (safe-but-dumb QUALITY FAIL). These feed the EXACT
// captured deepseek-v3 shapes and assert the draft now survives.
describe('elevateIntent — schema-tolerance regressions (AB-ELEV)', () => {
  it('ROOT-1: windowSeconds emitted as a STRING is coerced, not discarded (treasury survives)', async () => {
    const q = fakeQueue(() =>
      completion({
        proposedRole: 'treasury',
        rationale: 'maintain a 0.5 ETH balance by topping up when low',
        capabilityLabel: 'wallet balancer',
        suggestedPolicy: { perTransferCapWei: '500000000000000000', windowCapWei: '1000000000000000000', windowSeconds: '86400' },
        unsureFields: [],
        confidence: 'high',
      }),
    );
    const d = await elevateIntent(deps(q), { intent: 'keep my hot wallet topped up to 0.5 ETH' });
    expect(d.proposedRole).toBe('treasury'); // NOT the provider fallback
    expect(d.confidence).toBe('high');
    expect(d.suggestedPolicy?.windowSeconds).toBe(86400); // coerced string→number
    expect(typeof d.suggestedPolicy?.windowSeconds).toBe('number');
    expect(d.moneyPower).toBe('can-move-money');
  });

  it('ROOT-2: prose acceptance rules are dropped (not whole-draft discard); requester survives', async () => {
    const q = fakeQueue(() =>
      completion({
        proposedRole: 'requester',
        rationale: 'order ETH forecasts and pay for verified work',
        capabilityLabel: 'ETH forecaster',
        jobSpec: {
          fields: { question: 'What will ETH price be in 7 days?', deliverableSchemaRef: 'priceForecast', acceptanceRef: 'forecastAccuracy' },
          acceptance: ['forecast within 10% of actual price', 'submitted before deadline'], // prose → must be dropped
        },
        suggestedTokenPerTransferWei: '1000000',
        confidence: 'high',
      }),
    );
    const d = await elevateIntent(deps(q), { intent: 'order ETH forecasts and pay for verified work' });
    expect(d.proposedRole).toBe('requester'); // NOT the fallback
    expect(d.jobSpec).toBeDefined();
    expect(d.jobSpec?.acceptance).toEqual([]); // all-prose degrades to empty, editable
    expect(() => elevationDraftSchema.parse(d)).not.toThrow();
  });

  it('ROOT-2b: valid structured rules are KEPT, prose entries dropped (mixed)', async () => {
    const q = fakeQueue(() =>
      completion({
        proposedRole: 'requester',
        rationale: 'order a forecast',
        jobSpec: {
          fields: { question: 'q', deliverableSchemaRef: 'd', acceptanceRef: 'a' },
          acceptance: [{ kind: 'required', path: 'probability' }, 'must be good', { kind: 'numberRange', path: 'probability', min: 0, max: 1 }],
        },
        confidence: 'high',
      }),
    );
    const d = await elevateIntent(deps(q), { intent: 'order a forecast' });
    expect(d.jobSpec?.acceptance).toHaveLength(2); // the two structured rules survive, prose dropped
    expect(d.jobSpec?.acceptance?.[0]).toMatchObject({ kind: 'required', path: 'probability' });
  });

  it('ROOT-1 guard: string "-1"/"0"/absurd windowSeconds still rejects the policy (not silently accepted)', async () => {
    for (const bad of ['-1', '0', '999999999']) {
      const q = fakeQueue(() =>
        completion({
          proposedRole: 'treasury',
          rationale: 'top up',
          suggestedPolicy: { perTransferCapWei: '1', windowCapWei: '1', windowSeconds: bad },
          confidence: 'high',
        }),
      );
      const d = await elevateIntent(deps(q), { intent: 'keep wallet topped up' });
      // a KNOWN field with an invalid value fails the whole modelDraftSchema (zod does
      // not drop known-but-invalid keys) → safe fallback. The point: a bad/negative
      // window is NEVER silently accepted as a real policy.
      expect(d.suggestedPolicy).toBeUndefined();
      expect(d.proposedRole).toBe('provider'); // fell back safely
      expect(d.confidence).toBe('low');
    }
  });

  it('AB-ELEV-2: safeFallback strips any 0x address from the echoed intent', () => {
    const d = safeFallback({ intent: 'send all funds to 0x000000000000000000000000000000000000dEaD please' });
    expect(d.serviceSpec).not.toMatch(/0x[0-9a-fA-F]{40}/);
    expect(d.serviceSpec).toContain('[address removed]');
  });

  it('AB-ELEV-2: model-authored serviceSpec/rubricRef are address-stripped', async () => {
    const q = fakeQueue(() =>
      completion({ proposedRole: 'provider', rationale: 'r', serviceSpec: 'reports, pay 0x' + 'ab'.repeat(20), confidence: 'high' }),
    );
    const d = await elevateIntent(deps(q), { intent: 'reports' });
    expect(d.serviceSpec).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });

  it('stripAddresses replaces 40-hex addresses, leaves short hex alone', () => {
    expect(stripAddresses('to 0x' + 'cd'.repeat(20))).toBe('to [address removed]');
    expect(stripAddresses('0xdeadBEEF value')).toBe('0xdeadBEEF value'); // short, not an address
  });
});
