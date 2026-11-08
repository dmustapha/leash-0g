import { describe, it, expect } from 'vitest';
import { buildReasonRequest, type ReasonContext, type PolicySnapshot } from '../../src/runtime/prompt.js';
import type { TreasuryGoal } from '../../src/types.js';

/**
 * C9: a token-denominated treasury goal must reason over TOKEN balances in the token's own symbol.
 * Before: the observation carried the NATIVE balances and "0G" display, so the model compared a token
 * target against a native balance (and read the account's native 0 as "broke") and stood down.
 * A native treasury must stay byte-identical.
 */
const POLICY: PolicySnapshot = {
  perTransferCapWei: '10000000000000000',
  windowCapWei: '50000000000000000',
  windowSeconds: 86400,
  expiresAt: 2_000_000_000,
  allowlist: ['0x' + '9c'.repeat(20)],
  revoked: false,
  spentInWindowWei: '0',
  remainingWindowWei: '50000000000000000',
  windowResetsAtUnix: 1_900_086_400,
};
const NATIVE_GOAL: TreasuryGoal = { beneficiary: '0x' + '9c'.repeat(20), targetBalanceWei: '100000000000000000', topUpWei: '10000000000000000' };
const TOKEN_GOAL: TreasuryGoal = { beneficiary: '0x' + '9c'.repeat(20), token: '0x' + 'ec'.repeat(20), targetBalanceWei: '10000000', topUpWei: '10000' };

function base(over: Partial<ReasonContext>): ReasonContext {
  return { goal: NATIVE_GOAL, beneficiaryBalanceWei: '57000000000000000', accountBalanceWei: '0', policy: POLICY, nowSec: 1_900_000_000, ...over };
}
const parts = (c: ReasonContext) => {
  const body = buildReasonRequest('m', c) as { messages: Array<{ content: string }> };
  return { sys: body.messages[0]!.content, obs: JSON.parse(body.messages[1]!.content.replace('Observation:\n', '')) as Record<string, unknown> };
};

describe('token-denominated treasury reasoning (C9)', () => {
  const tokenCtx = base({
    goal: TOKEN_GOAL,
    tokenTreasury: { symbol: 'USDC', decimals: 6, beneficiaryBalanceWei: '4000000', accountBalanceWei: '2000000' },
  });

  it('the observation carries TOKEN balances, not the native ones', () => {
    const { obs } = parts(tokenCtx);
    expect(obs['beneficiaryBalanceWei']).toBe('4000000');
    expect(obs['accountBalanceWei']).toBe('2000000');
  });

  it('display words are in the token symbol and never mention 0G', () => {
    const { obs } = parts(tokenCtx);
    expect(obs['display']).toEqual({ token: 'USDC', accountBalance: '2 USDC', beneficiaryBalance: '4 USDC', targetBalance: '10 USDC', topUp: '0.01 USDC' });
    expect(JSON.stringify(obs['display'])).not.toMatch(/0G/);
  });

  it('the system prompt swaps the native amount rules for the token rules', () => {
    const { sys } = parts(tokenCtx);
    expect(sys).toContain('denominated in an ERC-20 token');
    expect(sys).not.toContain('The native token of this chain is 0G');
  });

  it('unreadable token meta renders honest "units", never a wrong symbol', () => {
    const { obs } = parts(base({ goal: TOKEN_GOAL, tokenTreasury: { symbol: null, decimals: null, beneficiaryBalanceWei: '4000000', accountBalanceWei: '2000000' } }));
    expect((obs['display'] as Record<string, string>)['accountBalance']).toBe('2000000 units');
  });

  it('a NATIVE treasury is unchanged: native balances, 0G display, native rules', () => {
    const { sys, obs } = parts(base({}));
    expect(obs['beneficiaryBalanceWei']).toBe('57000000000000000');
    expect(obs['accountBalanceWei']).toBe('0');
    expect((obs['display'] as Record<string, string>)['nativeToken']).toBe('0G');
    expect(sys).toContain('The native token of this chain is 0G');
    expect(sys).not.toContain('denominated in an ERC-20 token');
  });

  describe('D5-2: the policy the agent reads is the TOKEN budget, not the native one', () => {
    const TOKEN_POLICY: PolicySnapshot = {
      ...POLICY,
      perTransferCapWei: '5000000',
      windowCapWei: '5000000',
      spentInWindowWei: '1000000',
      remainingWindowWei: '4000000',
      assetToken: '0x' + 'ec'.repeat(20),
    };
    const ctx = base({
      goal: TOKEN_GOAL,
      policy: TOKEN_POLICY,
      tokenTreasury: { symbol: 'NOVL', decimals: 18, beneficiaryBalanceWei: '4000000', accountBalanceWei: '2000000' },
    });

    it('the observation policy carries the token caps and says which asset they are in', () => {
      const { obs } = parts(ctx);
      const pol = obs['policy'] as Record<string, unknown>;
      expect(pol['perTransferCapWei']).toBe('5000000');
      expect(pol['remainingWindowWei']).toBe('4000000');
      expect(pol['assetToken']).toBe('0x' + 'ec'.repeat(20));
    });

    it('display words for the caps are in the token symbol, never 0G', () => {
      const d = parts(base({ ...ctx, tokenTreasury: { symbol: 'USDC', decimals: 6, beneficiaryBalanceWei: '4000000', accountBalanceWei: '2000000' } })).obs['display'] as Record<string, string>;
      expect(d['perTransferCap']).toBe('5 USDC');
      expect(d['windowCap']).toBe('5 USDC');
      expect(d['spentInWindow']).toBe('1 USDC');
      expect(d['remainingWindow']).toBe('4 USDC');
      expect(JSON.stringify(d)).not.toMatch(/0G/);
    });

    it('the rules no longer tell the model to ignore policy when it is the token budget', () => {
      const { sys } = parts(ctx);
      expect(sys).not.toContain('policy.* is the native-coin spending policy');
      expect(sys).toContain("policy.* is this token's on-chain budget");
    });

    it('without a token budget (not enabled) the old native-policy rule stays', () => {
      const { sys, obs } = parts(base({ goal: TOKEN_GOAL, tokenTreasury: { symbol: 'USDC', decimals: 6, beneficiaryBalanceWei: '0', accountBalanceWei: '0' } }));
      expect(sys).toContain('policy.* is the native-coin spending policy');
      expect((obs['display'] as Record<string, string>)['perTransferCap']).toBeUndefined();
    });
  });

  describe('S1: hard token budget — the model call is never made with a bigger max_tokens', () => {
    it('max_tokens is a fixed server-side clamp (a length/loop failure is never retried with more tokens)', () => {
      for (const c of [base({}), base({ goal: TOKEN_GOAL, tokenTreasury: { symbol: 'USDC', decimals: 6, beneficiaryBalanceWei: '4000000', accountBalanceWei: '2000000' } })]) {
        const body = buildReasonRequest('m', c) as { max_tokens: number };
        expect(body.max_tokens).toBe(4096);
      }
    });
  });
});
