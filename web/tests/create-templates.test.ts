// File: web/tests/create-templates.test.ts
// Phase-5 (D-B5): every curated template is a valid ElevationDraft — correct money-power for its
// role, no smuggled address, and providers/evaluators carry no fee.
import { describe, expect, it } from 'vitest';
import { CREATE_TEMPLATES } from '@/components/create/templates';

describe('CREATE_TEMPLATES', () => {
  it('has ≥2 curated templates including the two named archetypes', () => {
    expect(CREATE_TEMPLATES.length).toBeGreaterThanOrEqual(2);
    const ids = CREATE_TEMPLATES.map((t) => t.id);
    expect(ids).toContain('market-forecaster');
    expect(ids).toContain('research-summarizer');
  });

  it('every draft has a coherent money-power for its role and no smuggled address/fee', () => {
    const SPENDERS = new Set(['treasury', 'executor', 'requester']);
    for (const t of CREATE_TEMPLATES) {
      const d = t.draft;
      const expected = SPENDERS.has(d.proposedRole) ? 'can-move-money' : 'cannot-move-money';
      expect(d.moneyPower, `${t.id} money-power`).toBe(expected);
      // Never-guess-money: no address anywhere in a template, no fee on a spend-incapable role.
      expect(JSON.stringify(d)).not.toMatch(/0x[0-9a-fA-F]{40}/);
      if (!SPENDERS.has(d.proposedRole)) {
        expect(d.suggestedFeeBaseUnits, `${t.id} fee`).toBeUndefined();
      }
      expect(Array.isArray(d.unsureFields)).toBe(true);
    }
  });

  it('the two provider archetypes ship a serviceSpec and cannot move money', () => {
    for (const id of ['market-forecaster', 'research-summarizer']) {
      const d = CREATE_TEMPLATES.find((t) => t.id === id)!.draft;
      expect(d.proposedRole).toBe('provider');
      expect(d.serviceSpec).toBeTruthy();
      expect(d.moneyPower).toBe('cannot-move-money');
    }
  });
});
