import { describe, it, expect } from 'vitest';
import { elevateDirection, type DirectRequest } from '../../src/direction/direction.js';
import type { ComputeQueue } from '../../src/gateway/compute-queue.js';
import type { AgentGoal } from '../../src/types.js';

const TREASURY: AgentGoal = { type: 'treasury', beneficiary: '0x' + '11'.repeat(20), targetBalanceWei: '1000', topUpWei: '500' };
const PROVIDER: AgentGoal = { type: 'provider', serviceSpec: 'summaries' };

/** Fake ComputeQueue returning a canned model completion (or a failure). */
function fakeQueue(content: unknown, opts: { status?: number; throws?: boolean } = {}): ComputeQueue {
  return {
    async enqueue() {
      if (opts.throws) throw new Error('network');
      const text = typeof content === 'string' ? content : JSON.stringify(content);
      return { status: opts.status ?? 200, body: { choices: [{ message: { content: text } }] } };
    },
  } as unknown as ComputeQueue;
}

function req(goal: AgentGoal, intent: string): DirectRequest {
  return { agentId: 'a1', currentGoal: goal, intent };
}

describe('elevateDirection', () => {
  it('produces a descriptive treasury threshold patch', async () => {
    const q = fakeQueue({ understanding: 'raise the target to 2000', goalPatch: { targetBalanceWei: '2000' }, confidence: 'high' });
    const d = await elevateDirection({ queue: q, model: 'm' }, req(TREASURY, 'keep it topped to 2000 wei'));
    expect(d.currentRole).toBe('treasury');
    expect(d.goalPatch).toEqual({ targetBalanceWei: '2000' });
    expect(d.confidence).toBe('high');
  });

  it('R-2: moneyPower is server-computed, NOT trusted from the model', async () => {
    // Model tries to claim a spender cannot move money — ignored; server derives it.
    const q = fakeQueue({ understanding: 'x', moneyPower: 'cannot-move-money', confidence: 'high' } as unknown);
    const d = await elevateDirection({ queue: q, model: 'm' }, req(TREASURY, 'do stuff'));
    expect(d.moneyPower).toBe('can-move-money');
    const dp = await elevateDirection({ queue: q, model: 'm' }, req(PROVIDER, 'do stuff'));
    expect(dp.moneyPower).toBe('cannot-move-money');
  });

  it('never-guess-money: drops a hallucinated address/token; no address in the draft', async () => {
    const q = fakeQueue({
      understanding: 'pay a new recipient',
      goalPatch: { feeRecipient: '0x' + 'de'.repeat(20), targetBalanceWei: '3000' },
      feeRecipient: '0x' + 'de'.repeat(20),
      settlementToken: '0x' + 'ad'.repeat(20),
      confidence: 'high',
    });
    const d = await elevateDirection({ queue: q, model: 'm' }, req(TREASURY, 'change things'));
    expect(JSON.stringify(d)).not.toMatch(/0x[0-9a-f]{40}/i);
    // only the descriptive key survives the filter
    expect(d.goalPatch).toEqual({ targetBalanceWei: '3000' });
  });

  it('a fee is prefilled ONLY from the owner stated base-units amount (requester)', async () => {
    const requester: AgentGoal = {
      type: 'requester', jobSpecSource: 'js', providerAgentId: 'p', evaluatorAgentId: 'e',
      feeToken: '0x' + '22'.repeat(20), feeRecipient: '0x' + '33'.repeat(20), feeCapPerJobWei: '9',
    };
    const q = fakeQueue({ understanding: 'pay more', confidence: 'high' });
    const withAmount = await elevateDirection({ queue: q, model: 'm' }, req(requester, 'pay 5000 base units per job'));
    expect(withAmount.suggestedFeeBaseUnits).toBe('5000');
    const withoutAmount = await elevateDirection({ queue: q, model: 'm' }, req(requester, 'pay more please'));
    expect(withoutAmount.suggestedFeeBaseUnits).toBeUndefined();
  });

  it('an out-of-union / role-change patch collapses to a no-op low-confidence draft', async () => {
    const q = fakeQueue({ understanding: 'become a spender', goalPatch: { type: 'treasury', beneficiary: '0x' + '99'.repeat(20) }, confidence: 'high' });
    const d = await elevateDirection({ queue: q, model: 'm' }, req(PROVIDER, 'start paying people'));
    expect(d.goalPatch).toEqual({});
    expect(d.confidence).toBe('low');
    expect(d.currentRole).toBe('provider');
  });

  it('malformed model output => safe no-op fallback (never throws)', async () => {
    const q = fakeQueue('garbage {');
    const d = await elevateDirection({ queue: q, model: 'm' }, req(TREASURY, 'x'));
    expect(d.confidence).toBe('low');
    expect(d.goalPatch).toEqual({});
    expect(d.unsureFields).toContain('intent');
  });

  it('network failure => safe fallback', async () => {
    const q = fakeQueue(null, { throws: true });
    const d = await elevateDirection({ queue: q, model: 'm', maxRetries: 0 }, req(TREASURY, 'x'));
    expect(d.confidence).toBe('low');
    expect(d.goalPatch).toEqual({});
  });

  it('carries a valid acceptancePatch through', async () => {
    const q = fakeQueue({ understanding: 'tighten acceptance', acceptancePatch: [{ kind: 'required', path: 'probability' }], confidence: 'high' });
    const d = await elevateDirection({ queue: q, model: 'm' }, req(PROVIDER, 'require a probability field'));
    expect(d.acceptancePatch).toEqual([{ kind: 'required', path: 'probability' }]);
  });
});
