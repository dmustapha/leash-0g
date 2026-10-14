// RH2 (B1): the owner-arming helpers must encode a V5 trader account's band/call-rule/spend
// txs against the V5 superset ABI (LEASH_ACCOUNT_V5_ABI), while a V4/legacy account keeps the
// V4 ABI — additive, version-gated, no V4 behavior change. These helpers are presentation-free:
// the version is threaded from the panel call site into chain.ts, which picks the ABI. We assert
// the ABI actually handed to viem's simulateContract carries a V5-only fragment for version 5 and
// does NOT for version 4 — the correctness guarantee that unblocks V5-only accounts.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Abi, AbiFunction } from 'viem';

// Capture every simulateContract call's ABI. The wallet writeContract is a no-op stub.
const simulateCalls: Array<{ functionName: string; abi: Abi }> = [];

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: () => ({
      simulateContract: async (args: { functionName: string; abi: Abi }) => {
        simulateCalls.push({ functionName: args.functionName, abi: args.abi });
        return { request: { ...args } };
      },
      readContract: async () => 0n,
      waitForTransactionReceipt: async () => ({}),
      getBalance: async () => 0n,
    }),
    createWalletClient: () => ({
      writeContract: async () => '0xdeadbeef' as `0x${string}`,
      sendTransaction: async () => '0xdeadbeef' as `0x${string}`,
    }),
  };
});

// Imported AFTER the mock is registered.
import {
  proposeCallRuleOnchain,
  tightenPriceBandOnchain,
  enableRequireBandForSwapOnchain,
  proposeSpendBudgetOnchain,
  applyCallRuleOnchain,
  type CallRuleInput,
} from '../lib/chain';

const PROVIDER = {
  request: async ({ method }: { method: string }) =>
    method === 'eth_chainId' ? '0x40d8' : undefined,
} as unknown as import('viem').EIP1193Provider;

const OWNER = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const ACCOUNT = '0x2222222222222222222222222222222222222222' as `0x${string}`;
const TARGET = '0x3333333333333333333333333333333333333333' as `0x${string}`;
const FEED = '0x4444444444444444444444444444444444444444' as `0x${string}`;
const ASSET = '0x5555555555555555555555555555555555555555' as `0x${string}`;

const RULE: CallRuleInput = {
  target: TARGET,
  selector: '0x9908fc8b',
  recipientMode: 'self',
  spenderSet: [],
  perCallCap: '1000',
  windowCapCall: '5000',
};

/** A fragment that exists ONLY in the V5 superset ABI (the governed-signing surface) —
 *  its presence proves the ABI handed to viem was the V5 one, not V4. */
function hasV5OnlyFragment(abi: Abi): boolean {
  return abi.some((f) => f.type === 'function' && (f as AbiFunction).name === 'proposeSigningGrantNested');
}

function lastCall() {
  return simulateCalls[simulateCalls.length - 1]!;
}

describe('chain.ts version-aware owner-write encoding (B1)', () => {
  beforeEach(() => {
    simulateCalls.length = 0;
  });

  it('encodes a V5 account call-rule propose against the V5 superset ABI', async () => {
    await proposeCallRuleOnchain(PROVIDER, OWNER, ACCOUNT, RULE, 16602, 5);
    const call = lastCall();
    expect(call.functionName).toBe('proposeCallRule');
    expect(hasV5OnlyFragment(call.abi)).toBe(true);
  });

  it('encodes a V4 account call-rule propose against the V4 ABI (no V5-only fragment)', async () => {
    await proposeCallRuleOnchain(PROVIDER, OWNER, ACCOUNT, RULE, 16602, 4);
    expect(hasV5OnlyFragment(lastCall().abi)).toBe(false);
  });

  it('defaults to the V4 ABI when version is omitted (legacy byte-identical path)', async () => {
    await proposeCallRuleOnchain(PROVIDER, OWNER, ACCOUNT, RULE, 16602);
    expect(hasV5OnlyFragment(lastCall().abi)).toBe(false);
  });

  it('encodes a V5 price-band tighten against the V5 superset ABI', async () => {
    await tightenPriceBandOnchain(
      PROVIDER,
      OWNER,
      ACCOUNT,
      { target: TARGET, feed: FEED, asset: ASSET, maxDeviationBps: 500, maxStalenessSec: 3600 },
      16602,
      5,
    );
    const call = lastCall();
    expect(call.functionName).toBe('tightenPriceBand');
    expect(hasV5OnlyFragment(call.abi)).toBe(true);
  });

  it('encodes a V5 enableRequireBandForSwap against the V5 superset ABI', async () => {
    await enableRequireBandForSwapOnchain(PROVIDER, OWNER, ACCOUNT, 16602, 5);
    const call = lastCall();
    expect(call.functionName).toBe('enableRequireBandForSwap');
    expect(hasV5OnlyFragment(call.abi)).toBe(true);
  });

  it('encodes a V5 spend-budget propose + call-rule apply against the V5 superset ABI', async () => {
    await proposeSpendBudgetOnchain(PROVIDER, OWNER, ACCOUNT, ASSET, '9000', 16602, 5);
    expect(lastCall().functionName).toBe('proposeSpendBudget');
    expect(hasV5OnlyFragment(lastCall().abi)).toBe(true);

    await applyCallRuleOnchain(PROVIDER, OWNER, ACCOUNT, 16602, 5);
    expect(lastCall().functionName).toBe('applyCallRule');
    expect(hasV5OnlyFragment(lastCall().abi)).toBe(true);
  });

  it('keeps the band selector byte-identical across V4 and V5 encodings', async () => {
    await tightenPriceBandOnchain(PROVIDER, OWNER, ACCOUNT, { target: TARGET, feed: FEED, asset: ASSET, maxDeviationBps: 500, maxStalenessSec: 3600 }, 16602, 4);
    const v4Frag = lastCall().abi.find((f) => f.type === 'function' && (f as AbiFunction).name === 'tightenPriceBand');
    await tightenPriceBandOnchain(PROVIDER, OWNER, ACCOUNT, { target: TARGET, feed: FEED, asset: ASSET, maxDeviationBps: 500, maxStalenessSec: 3600 }, 16602, 5);
    const v5Frag = lastCall().abi.find((f) => f.type === 'function' && (f as AbiFunction).name === 'tightenPriceBand');
    // Same fragment shape ⇒ same selector ⇒ V4 behavior unchanged under the V5 ABI.
    expect(JSON.stringify(v4Frag)).toEqual(JSON.stringify(v5Frag));
  });
});
