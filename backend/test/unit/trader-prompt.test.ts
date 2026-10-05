import { describe, it, expect } from 'vitest';
import { buildReasonRequest, type ReasonContext, type PolicySnapshot } from '../../src/runtime/prompt.js';
import type { TraderGoal } from '../../src/types.js';

/**
 * FR3 (F-8): the trader reason contract — the system prompt carries the
 * mechanical trade ladder, and the observation carries the owner-typed goal
 * tokens + server-sensed holdings (never a recipient/spender to choose).
 */

const POLICY: PolicySnapshot = {
  perTransferCapWei: '0',
  windowCapWei: '0',
  windowSeconds: 0,
  expiresAt: 2_000_000_000,
  allowlist: [],
  revoked: false,
  spentInWindowWei: '0',
  remainingWindowWei: '0',
  windowResetsAtUnix: 0,
};

const GOAL: TraderGoal = {
  type: 'trader',
  holdToken: '0x' + '44'.repeat(20),
  spendToken: '0x' + '55'.repeat(20),
  targetHoldWei: '1000000000000000000',
  clipWei: '100000000000000000000',
};

function ctx(over: Partial<ReasonContext> = {}): ReasonContext {
  return {
    goal: GOAL,
    beneficiaryBalanceWei: '0',
    accountBalanceWei: '0',
    policy: POLICY,
    nowSec: 1_900_000_000,
    holdings: { holdBalanceWei: '0', spendBalanceWei: '1000000000000000000000', routerAllowanceWei: '0' },
    capabilities: [
      { target: '0x' + '55'.repeat(20), selector: '0x095ea7b3', signature: 'function approve(address spender, uint256 amount)', perCallCap: '100000000000000000000' },
    ],
    ...over,
  };
}

describe('trader reason request (FR3)', () => {
  it('uses the trader system prompt (trade ladder, never send)', () => {
    const body = buildReasonRequest('m', ctx()) as { messages: Array<{ role: string; content: string }> };
    const sys = body.messages[0]?.content ?? '';
    expect(sys).toMatch(/trading agent/i);
    expect(sys).toMatch(/action "send" is forbidden/i);
    expect(sys).toMatch(/clip/i);
  });

  it('observation carries the owner-typed token pair + sensed holdings, never a recipient', () => {
    const body = buildReasonRequest('m', ctx()) as { messages: Array<{ role: string; content: string }> };
    const obs = JSON.parse((body.messages[1]?.content ?? '').replace(/^Observation:\n/, ''));
    expect(obs.goal).toEqual({
      holdToken: GOAL.holdToken,
      spendToken: GOAL.spendToken,
      targetHoldWei: GOAL.targetHoldWei,
      clipWei: GOAL.clipWei,
    });
    expect(obs.holdings).toEqual({
      holdBalanceWei: '0',
      spendBalanceWei: '1000000000000000000000',
      routerAllowanceWei: '0',
    });
    expect(obs.capabilities).toHaveLength(1);
    // never-guess-money: no recipient/spender address surface for the model to fill
    expect(obs.goal.recipient).toBeUndefined();
    expect(obs.goal.beneficiary).toBeUndefined();
    expect(obs.capabilities[0].spenders).toBeUndefined();
    expect(obs.capabilities[0].recipient).toBeUndefined();
  });

  it('omits holdings for a non-trader context (treasury unchanged)', () => {
    const body = buildReasonRequest('m', {
      ...ctx({ holdings: undefined as never }),
      goal: { beneficiary: '0x' + '11'.repeat(20), targetBalanceWei: '1', topUpWei: '1' },
    } as ReasonContext) as { messages: Array<{ role: string; content: string }> };
    const obs = JSON.parse((body.messages[1]?.content ?? '').replace(/^Observation:\n/, ''));
    expect(obs.holdings).toBeUndefined();
    expect(obs.goal.beneficiary).toBeDefined();
  });
});

// FR3b: reasoning models emit the DECISION_CONTRACT's target/selector keys EMPTY
// on stand_down (observed live on RH) — ""/null must parse as absent, not fail.
describe('parseDecision — empty target/selector tolerance (FR3b)', () => {
  it('parses a stand_down carrying "target":"" and "selector":""', async () => {
    const { parseDecision } = await import('../../src/runtime/prompt.js');
    const d = parseDecision('{"action":"stand_down","amountWei":"0","reason":"Target met.","target":"","selector":""}');
    expect(d).not.toBeNull();
    expect(d?.action).toBe('stand_down');
    expect(d?.target).toBeUndefined();
  });
  it('still rejects a CALL with empty target/selector (malformed)', async () => {
    const { parseDecision } = await import('../../src/runtime/prompt.js');
    expect(parseDecision('{"action":"call","amountWei":"5","reason":"x","target":"","selector":""}')).toBeNull();
  });
  it('still parses a well-formed call', async () => {
    const { parseDecision } = await import('../../src/runtime/prompt.js');
    const d = parseDecision(`{"action":"call","amountWei":"5","reason":"x","target":"0x${'aa'.repeat(20)}","selector":"0x095ea7b3"}`);
    expect(d?.action).toBe('call');
    expect(d?.target).toBeDefined();
  });
});
