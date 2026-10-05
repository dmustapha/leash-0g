import { describe, it, expect } from 'vitest';
import { revalidateEffectiveGoal } from '../../src/direction/goal-schema.js';
import type { AgentGoal } from '../../src/types.js';

/**
 * C1 (Phase 5.5 INFO-1, folded into 5.6): revalidateEffectiveGoal rejects an
 * effective goal that changed a money-authority field — defence-in-depth at the
 * runtime apply boundary, since a chain amplifies blast radius.
 */

const REQUESTER: AgentGoal = {
  type: 'requester',
  jobSpecSource: 'ref-1',
  providerAgentId: 'p1',
  evaluatorAgentId: 'e1',
  feeToken: '0x' + '11'.repeat(20),
  feeRecipient: '0x' + '22'.repeat(20),
  feeCapPerJobWei: '1000',
};

describe('revalidateEffectiveGoal — C1 money-authority invariant', () => {
  it('accepts an unchanged goal', () => {
    expect(revalidateEffectiveGoal(REQUESTER, REQUESTER).ok).toBe(true);
  });

  it('rejects a widened fee cap', () => {
    const r = revalidateEffectiveGoal(REQUESTER, { ...REQUESTER, feeCapPerJobWei: '999999' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/money-authority field \(feeCapPerJobWei\)/);
  });

  it('rejects a swapped settlement token', () => {
    const r = revalidateEffectiveGoal(REQUESTER, { ...REQUESTER, feeToken: '0x' + '33'.repeat(20) });
    expect(r.ok).toBe(false);
  });

  it('rejects a re-bound provider/evaluator', () => {
    expect(revalidateEffectiveGoal(REQUESTER, { ...REQUESTER, providerAgentId: 'evil' }).ok).toBe(false);
    expect(revalidateEffectiveGoal(REQUESTER, { ...REQUESTER, evaluatorAgentId: 'evil' }).ok).toBe(false);
  });

  it('allows the sanctioned out-of-band feeRecipient re-target (address is not invariant)', () => {
    const r = revalidateEffectiveGoal(REQUESTER, { ...REQUESTER, feeRecipient: '0x' + '44'.repeat(20) });
    expect(r.ok).toBe(true);
  });
});

// FR3 (F-8): the trader's token pair is owner-typed money authority — a
// tampered/stale effective goal that re-points either token is rejected at the
// apply boundary; the descriptive amounts may change (they flow via applyGoalPatch).
describe('revalidateEffectiveGoal — trader token-pair invariant (FR3)', () => {
  const TRADER: AgentGoal = {
    type: 'trader',
    holdToken: '0x' + '44'.repeat(20),
    spendToken: '0x' + '55'.repeat(20),
    targetHoldWei: '1000',
    clipWei: '100',
  };
  it('accepts an unchanged trader goal (and changed descriptive amounts)', () => {
    expect(revalidateEffectiveGoal(TRADER, TRADER).ok).toBe(true);
    expect(revalidateEffectiveGoal(TRADER, { ...TRADER, targetHoldWei: '9000', clipWei: '50' }).ok).toBe(true);
  });
  it('rejects a re-pointed holdToken / spendToken', () => {
    const h = revalidateEffectiveGoal(TRADER, { ...TRADER, holdToken: '0x' + '99'.repeat(20) });
    expect(h.ok).toBe(false);
    if (!h.ok) expect(h.reason).toMatch(/money-authority field \(holdToken\)/);
    expect(revalidateEffectiveGoal(TRADER, { ...TRADER, spendToken: '0x' + '99'.repeat(20) }).ok).toBe(false);
  });
});
