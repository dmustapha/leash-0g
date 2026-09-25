// File: web/tests/draft-to-prefill.test.ts
// Phase-5 (D-B3): the pure draft→wizard mapping. NEVER-GUESS-MONEY: the address comes ONLY from
// the owner-typed recipient (never the model draft); requester token/fee stay blank when unstated.
import { describe, expect, it } from 'vitest';
import { draftToPrefill } from '@/components/create/draft-to-prefill';
import type { ElevationDraft } from '@/lib/types';

const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

describe('draftToPrefill', () => {
  it('provider → spend-incapable goal, no allowlist', () => {
    const d: ElevationDraft = { proposedRole: 'provider', rationale: '', serviceSpec: 'x', moneyPower: 'cannot-move-money', unsureFields: [], confidence: 'high' };
    const p = draftToPrefill(d);
    expect(p.goal).toEqual({ type: 'provider', serviceSpec: 'x' });
    expect(p.allowlist).toEqual([]);
    expect(p.policy.perTransferCapWei).toBe('0');
  });

  it('sentinel → maps to a sentinel goal (not the requester fallback)', () => {
    const d: ElevationDraft = { proposedRole: 'sentinel', rationale: '', moneyPower: 'cannot-move-money', unsureFields: [], confidence: 'high' };
    const p = draftToPrefill(d);
    expect(p.goal.type).toBe('sentinel');
    expect(p.allowlist).toEqual([]);
    expect(p.policy.perTransferCapWei).toBe('0');
    // never corrupted into a requester (the pre-fix fallthrough bug)
    expect(p.goal).not.toHaveProperty('feeToken');
  });

  it('treasury → seeds suggested caps + owner-typed recipient as allowlist/beneficiary', () => {
    const d: ElevationDraft = {
      proposedRole: 'treasury',
      rationale: '',
      suggestedPolicy: { perTransferCapWei: '111', windowCapWei: '222', windowSeconds: 3600 },
      moneyPower: 'can-move-money',
      unsureFields: [],
      confidence: 'low',
    };
    const p = draftToPrefill(d, RECIPIENT);
    expect(p.policy.perTransferCapWei).toBe('111');
    expect(p.policy.windowCapWei).toBe('222');
    expect(p.allowlist).toEqual([RECIPIENT]);
    expect((p.goal as { beneficiary: string }).beneficiary).toBe(RECIPIENT);
  });

  it('treasury WITHOUT a recipient leaves the allowlist empty (never guessed)', () => {
    const d: ElevationDraft = { proposedRole: 'treasury', rationale: '', moneyPower: 'can-move-money', unsureFields: [], confidence: 'low' };
    const p = draftToPrefill(d);
    expect(p.allowlist).toEqual([]);
    expect((p.goal as { beneficiary: string }).beneficiary).toBe('');
  });

  it('requester → token + links BLANK; fee only if stated; recipient owner-typed', () => {
    const d: ElevationDraft = { proposedRole: 'requester', rationale: '', moneyPower: 'can-move-money', unsureFields: [], confidence: 'low' };
    const p = draftToPrefill(d, RECIPIENT);
    const g = p.goal as { type: string; feeToken: string; feeCapPerJobWei: string; providerAgentId: string; feeRecipient: string };
    expect(g.feeToken).toBe(''); // token never fabricated
    expect(g.feeCapPerJobWei).toBe(''); // no stated fee → blank
    expect(g.providerAgentId).toBe(''); // links left for the wizard
    expect(g.feeRecipient).toBe(RECIPIENT);
    expect(p.tokenConfig).toBeUndefined(); // owner completes token caps in the wizard
  });

  it('requester with a stated fee carries it through', () => {
    const d: ElevationDraft = { proposedRole: 'requester', rationale: '', suggestedFeeBaseUnits: '5000000', moneyPower: 'can-move-money', unsureFields: [], confidence: 'high' };
    const p = draftToPrefill(d, RECIPIENT);
    expect((p.goal as { feeCapPerJobWei: string }).feeCapPerJobWei).toBe('5000000');
  });

  it('capabilityLabel is threaded through', () => {
    const d: ElevationDraft = { proposedRole: 'provider', rationale: '', serviceSpec: 'x', capabilityLabel: 'forecaster', moneyPower: 'cannot-move-money', unsureFields: [], confidence: 'high' };
    expect(draftToPrefill(d).capabilityLabel).toBe('forecaster');
  });
});
