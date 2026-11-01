import { describe, it, expect } from 'vitest';
import { assertReceiptSuccess, SessionChain } from '../../src/runtime/session-chain.js';

const TX = '0x' + 'ab'.repeat(32);

describe('assertReceiptSuccess', () => {
  it('passes on a successful receipt', () => {
    expect(() => assertReceiptSuccess('success', TX)).not.toThrow();
  });

  it('throws on a reverted receipt so the transfer is never recorded as acted', () => {
    expect(() => assertReceiptSuccess('reverted', TX)).toThrow(`execute transfer reverted on-chain: ${TX}`);
  });
});

describe('SessionChain.readCallGrantState — token budget on V4 vs V6 accounts', () => {
  const ACCOUNT = '0xbab6fb622864faf686b870738e5c9aa1636c7423';
  const TOKEN = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
  const stubChain = (read: (fn: string) => unknown) => {
    const chain = Object.create(SessionChain.prototype) as SessionChain;
    (chain as unknown as { publicClient: unknown }).publicClient = {
      readContract: async ({ functionName }: { functionName: string }) => read(functionName),
    };
    return chain;
  };

  it('V4: reads the budget from spendBudget', async () => {
    const chain = stubChain((fn) => (fn === 'spendBudget' ? [true, 7n, 0n, 0n] : []));
    const s = await chain.readCallGrantState({ accountAddr: ACCOUNT, rules: [], tokens: [TOKEN] });
    expect(s.budgets.get(TOKEN)).toBe('7');
  });

  it('V6: spendBudget reverts, so the budget is the enabled assetPolicy windowCap', async () => {
    const chain = stubChain((fn) => {
      if (fn === 'spendBudget') throw new Error('execution reverted');
      return [true, 100n, 100_000_000n, 86400]; // enabled, perTransferCap, windowCap, windowSeconds
    });
    const s = await chain.readCallGrantState({ accountAddr: ACCOUNT, rules: [], tokens: [TOKEN] });
    expect(s.budgets.get(TOKEN)).toBe('100000000');
  });

  it('V6: a disabled asset policy is no budget', async () => {
    const chain = stubChain((fn) => {
      if (fn === 'spendBudget') throw new Error('execution reverted');
      return [false, 0n, 0n, 0];
    });
    const s = await chain.readCallGrantState({ accountAddr: ACCOUNT, rules: [], tokens: [TOKEN] });
    expect(s.budgets.has(TOKEN)).toBe(false);
  });
});
