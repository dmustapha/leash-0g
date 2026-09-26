import { describe, it, expect } from 'vitest';
import { applyGoalPatch, applyRecipient, revalidateEffectiveGoal, validateAcceptancePatch } from '../../src/direction/goal-schema.js';
import type { AgentGoal } from '../../src/types.js';

const TREASURY: AgentGoal = { type: 'treasury', beneficiary: '0x' + '11'.repeat(20), targetBalanceWei: '1000', topUpWei: '500' };
const PROVIDER: AgentGoal = { type: 'provider', serviceSpec: 'summaries' };
const REQUESTER: AgentGoal = { type: 'requester', jobSpecSource: 'js', providerAgentId: 'p', evaluatorAgentId: 'e', feeToken: '0x' + '22'.repeat(20), feeRecipient: '0x' + '33'.repeat(20), feeCapPerJobWei: '5' };

describe('STRESS: prototype pollution can never occur', () => {
  const pollutors = ['__proto__', 'constructor', 'prototype'];
  for (const key of pollutors) {
    it(`rejects '${key}' as a patch key and does NOT pollute Object.prototype`, () => {
      const patch = JSON.parse(`{"${key}": {"polluted": true}}`); // own-enumerable via JSON, the real request path
      const r = applyGoalPatch(TREASURY, patch);
      expect(r.ok).toBe(false);
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
      expect((Object.prototype as Record<string, unknown>)['polluted']).toBeUndefined();
    });
  }
  it('a whitelisted key carrying a nested pollutor value still fails strict parse', () => {
    const r = applyGoalPatch(TREASURY, { targetBalanceWei: { __proto__: { x: 1 } } as never });
    expect(r.ok).toBe(false);
  });
});

describe('STRESS: wei field boundary + smuggling', () => {
  const bad = [
    '', ' ', '  100  ', '0x64', '1e3', '-1', '1.5', '100n', 'NaN', 'Infinity',
    '01234567890123456789012345678901', // 32 digits (>30 → reject)
    '١٢٣', // Arabic-Indic digits — must NOT count as [0-9]
    '১', // Bengali digit
    '1​0', // zero-width space embedded
    'null', 'undefined', '+100', '100 ', ' 100',
  ];
  for (const v of bad) {
    it(`rejects targetBalanceWei = ${JSON.stringify(v)}`, () => {
      expect(applyGoalPatch(TREASURY, { targetBalanceWei: v }).ok).toBe(false);
    });
  }
  const good = ['0', '1', '000', '999999999999999999999999999999' /*30 nines*/];
  for (const v of good) {
    it(`accepts targetBalanceWei = ${JSON.stringify(v)}`, () => {
      expect(applyGoalPatch(TREASURY, { targetBalanceWei: v }).ok).toBe(true);
    });
  }
  it('rejects non-string wei (number, bool, null, array, object)', () => {
    for (const v of [100, true, null, [1], {}]) {
      expect(applyGoalPatch(TREASURY, { targetBalanceWei: v as never }).ok).toBe(false);
    }
  });
});

describe('STRESS: patch shape abuse', () => {
  it('array / string / number / null as the whole patch', () => {
    for (const p of [[1, 2] as never, 'x' as never, 5 as never]) {
      // non-object patches: Object.keys is [] or index keys → rejected or no-op
      const r = applyGoalPatch(TREASURY, p);
      // must never throw and never mutate role
      expect(typeof r.ok).toBe('boolean');
    }
    expect(applyGoalPatch(TREASURY, undefined).ok).toBe(true); // undefined = no-op
  });
  it('serviceSpec at the length boundary', () => {
    expect(applyGoalPatch(PROVIDER, { serviceSpec: 'a'.repeat(2000) }).ok).toBe(true);
    expect(applyGoalPatch(PROVIDER, { serviceSpec: 'a'.repeat(2001) }).ok).toBe(false);
    expect(applyGoalPatch(PROVIDER, { serviceSpec: '' }).ok).toBe(false); // min 1
  });
  it('emoji / unicode / newlines in serviceSpec are fine (it is descriptive text)', () => {
    expect(applyGoalPatch(PROVIDER, { serviceSpec: '📈 forecasts\nwith detail 中文' }).ok).toBe(true);
  });
  it('every money-authority field is rejected across roles', () => {
    expect(applyGoalPatch(REQUESTER, { feeToken: '0x' + 'aa'.repeat(20) } as never).ok).toBe(false);
    expect(applyGoalPatch(REQUESTER, { feeRecipient: '0x' + 'aa'.repeat(20) } as never).ok).toBe(false);
    expect(applyGoalPatch(REQUESTER, { feeCapPerJobWei: '9' } as never).ok).toBe(false);
    expect(applyGoalPatch(REQUESTER, { jobSpecSource: 'evil' } as never).ok).toBe(false);
    expect(applyGoalPatch(REQUESTER, { evaluatorAgentId: 'x' } as never).ok).toBe(false);
    expect(applyGoalPatch(TREASURY, { beneficiary: '0x' + 'aa'.repeat(20) } as never).ok).toBe(false);
    expect(applyGoalPatch(TREASURY, { model: 'evil-model' } as never).ok).toBe(false); // model not descriptive
  });
});

describe('STRESS: applyRecipient address parsing', () => {
  const badAddr = [' ', '0x', '0X' + '11'.repeat(20), '0x' + '11'.repeat(19), '0x' + '11'.repeat(20) + 'a', '11'.repeat(20), '0xZZ' + '11'.repeat(19), '0x' + '11'.repeat(20) + ' ', 'not-an-address'];
  for (const a of badAddr) {
    it(`rejects recipient ${JSON.stringify(a)}`, () => {
      expect(applyRecipient(TREASURY, a).ok).toBe(false);
    });
  }
  it('empty string is a safe NO-OP (owner typed no recipient) — goal unchanged, arms nothing', () => {
    const r = applyRecipient(TREASURY, '');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.goal).toEqual(TREASURY);
  });
  it('lowercases a checksummed/uppercase address', () => {
    const r = applyRecipient(TREASURY, '0x' + 'AB'.repeat(20));
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.goal as { beneficiary: string }).beneficiary).toBe('0x' + 'ab'.repeat(20));
  });
  it('spend-incapable roles reject any recipient', () => {
    for (const g of [PROVIDER, { type: 'evaluator', rubricRef: 'r' } as AgentGoal, { type: 'executor' } as AgentGoal]) {
      expect(applyRecipient(g, '0x' + 'cd'.repeat(20)).ok).toBe(false);
    }
  });
});

describe('STRESS: revalidateEffectiveGoal (apply boundary) rejects tampered goals', () => {
  it('rejects a role-swapped effective goal', () => {
    expect(revalidateEffectiveGoal(TREASURY, PROVIDER).ok).toBe(false);
  });
  it('rejects out-of-union shapes / junk', () => {
    for (const junk of [null, undefined, {}, { type: 'treasury' }, { type: 'hacker' }, [1, 2], 'x', 42, { type: 'treasury', beneficiary: 'nope', targetBalanceWei: '1', topUpWei: '1' }]) {
      expect(revalidateEffectiveGoal(TREASURY, junk).ok).toBe(false);
    }
  });
  it('accepts a same-role descriptive-only change', () => {
    expect(revalidateEffectiveGoal(TREASURY, { ...TREASURY, targetBalanceWei: '9999' }).ok).toBe(true);
  });
  it('rejects an effective goal that smuggles an extra key (strict union)', () => {
    expect(revalidateEffectiveGoal(TREASURY, { ...TREASURY, evil: 1 } as never).ok).toBe(false);
  });
});

describe('STRESS: validateAcceptancePatch', () => {
  it('rejects junk / oversized / empty / out-of-union', () => {
    expect(validateAcceptancePatch([]).ok).toBe(false); // min 1
    expect(validateAcceptancePatch(Array(65).fill({ kind: 'required', path: 'x' })).ok).toBe(false); // max 64
    expect(validateAcceptancePatch([{ kind: 'sql', path: 'x' }]).ok).toBe(false);
    expect(validateAcceptancePatch([{ kind: 'required' }]).ok).toBe(false); // missing path
    expect(validateAcceptancePatch('DROP TABLE' as never).ok).toBe(false);
    expect(validateAcceptancePatch(null).ok).toBe(false);
  });
  it('accepts a valid max-size ruleset', () => {
    expect(validateAcceptancePatch(Array(64).fill({ kind: 'required', path: 'p' })).ok).toBe(true);
  });
});
