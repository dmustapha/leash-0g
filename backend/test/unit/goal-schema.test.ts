import { describe, it, expect } from 'vitest';
import { applyGoalPatch, validateAcceptancePatch, applyRecipient, goalSchema } from '../../src/direction/goal-schema.js';
import type { AgentGoal } from '../../src/types.js';

const TREASURY: AgentGoal = { type: 'treasury', beneficiary: '0x' + '11'.repeat(20), targetBalanceWei: '1000', topUpWei: '500' };
const LEGACY_TREASURY: AgentGoal = { beneficiary: '0x' + '11'.repeat(20), targetBalanceWei: '1000', topUpWei: '500' } as AgentGoal;
const PROVIDER: AgentGoal = { type: 'provider', serviceSpec: 'summaries' };
const REQUESTER: AgentGoal = {
  type: 'requester',
  jobSpecSource: 'js-1',
  providerAgentId: 'p1',
  evaluatorAgentId: 'e1',
  feeToken: '0x' + '22'.repeat(20),
  feeRecipient: '0x' + '33'.repeat(20),
  feeCapPerJobWei: '5000000',
};

describe('applyGoalPatch — R-1 generality guard (happy)', () => {
  it('merges a descriptive treasury threshold change', () => {
    const r = applyGoalPatch(TREASURY, { targetBalanceWei: '2000' });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.goal as { targetBalanceWei: string }).targetBalanceWei).toBe('2000');
  });
  it('merges into a legacy (no-type) treasury and keeps it treasury', () => {
    const r = applyGoalPatch(LEGACY_TREASURY, { topUpWei: '750' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(goalSchema.safeParse(r.goal).success).toBe(true);
  });
  it('merges a provider serviceSpec', () => {
    const r = applyGoalPatch(PROVIDER, { serviceSpec: 'concise ETH forecasts' });
    expect(r.ok).toBe(true);
  });
  it('empty patch is a valid no-op', () => {
    const r = applyGoalPatch(TREASURY, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.goal).toEqual(TREASURY);
  });
});

describe('applyGoalPatch — R-1 adversarial (reject out-of-union / role change / money)', () => {
  it('REJECTS a role change via chat (type in patch)', () => {
    const r = applyGoalPatch(PROVIDER, { type: 'treasury', beneficiary: '0x' + '99'.repeat(20), targetBalanceWei: '1', topUpWei: '1' });
    expect(r.ok).toBe(false);
  });
  it('REJECTS a prompt-injected money-authority field (feeRecipient)', () => {
    const r = applyGoalPatch(REQUESTER, { feeRecipient: '0x' + 'de'.repeat(20) } as never);
    expect(r.ok).toBe(false);
  });
  it('REJECTS arming a treasury beneficiary address via patch (never-guess-money)', () => {
    const r = applyGoalPatch(TREASURY, { beneficiary: '0x' + 'de'.repeat(20) } as never);
    expect(r.ok).toBe(false);
  });
  it('REJECTS a settlement-token change via patch', () => {
    const r = applyGoalPatch(REQUESTER, { feeToken: '0x' + 'ad'.repeat(20) } as never);
    expect(r.ok).toBe(false);
  });
  it('REJECTS a cap-loosen via goalPatch (feeCapPerJobWei)', () => {
    const r = applyGoalPatch(REQUESTER, { feeCapPerJobWei: '999999999' } as never);
    expect(r.ok).toBe(false);
  });
  it('REJECTS a delegation binding change (providerAgentId)', () => {
    const r = applyGoalPatch(REQUESTER, { providerAgentId: 'evil' } as never);
    expect(r.ok).toBe(false);
  });
  it('REJECTS a completely unknown per-vertical field', () => {
    const r = applyGoalPatch(TREASURY, { rugPull: true } as never);
    expect(r.ok).toBe(false);
  });
  it('REJECTS a malformed wei value in a descriptive field', () => {
    const r = applyGoalPatch(TREASURY, { targetBalanceWei: 'not-wei' } as never);
    expect(r.ok).toBe(false);
  });
  it('executor has no descriptive surface — any patch is rejected', () => {
    const r = applyGoalPatch({ type: 'executor' }, { serviceSpec: 'x' } as never);
    expect(r.ok).toBe(false);
  });
});

describe('validateAcceptancePatch — R-1 acceptance union', () => {
  it('accepts rules from the existing union', () => {
    const r = validateAcceptancePatch([{ kind: 'required', path: 'probability' }]);
    expect(r.ok).toBe(true);
  });
  it('rejects an out-of-union rule kind', () => {
    const r = validateAcceptancePatch([{ kind: 'exec-shell', path: 'x' }]);
    expect(r.ok).toBe(false);
  });
  it('rejects a non-array', () => {
    expect(validateAcceptancePatch({ kind: 'required', path: 'x' }).ok).toBe(false);
  });
});

describe('applyRecipient — owner-typed out-of-band re-target', () => {
  it('sets treasury beneficiary from an owner-typed address', () => {
    const r = applyRecipient(TREASURY, '0x' + 'AB'.repeat(20));
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.goal as { beneficiary: string }).beneficiary).toBe('0x' + 'ab'.repeat(20));
  });
  it('sets requester feeRecipient', () => {
    const r = applyRecipient(REQUESTER, '0x' + 'cd'.repeat(20));
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.goal as { feeRecipient: string }).feeRecipient).toBe('0x' + 'cd'.repeat(20));
  });
  it('no recipient = unchanged', () => {
    const r = applyRecipient(TREASURY, undefined);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.goal).toEqual(TREASURY);
  });
  it('rejects a garbage address', () => {
    expect(applyRecipient(TREASURY, 'nope').ok).toBe(false);
  });
  it('rejects a recipient for a spend-incapable role', () => {
    expect(applyRecipient(PROVIDER, '0x' + 'cd'.repeat(20)).ok).toBe(false);
  });
});
