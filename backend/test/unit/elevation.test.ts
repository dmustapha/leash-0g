import { describe, it, expect } from 'vitest';
import {
  elevateIntent,
  elevationDraftSchema,
  feeFromIntent,
  moneyPowerOf,
  safeFallback,
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
