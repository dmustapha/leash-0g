import { describe, it, expect } from 'vitest';
import { decodeFunctionData, parseAbi } from 'viem';
import {
  buildCctpBurnCalls,
  decodeCall,
  classify,
  ruleKey,
  CCTP_STANDARD_FINALITY,
  type CallRule,
  type GrantState,
} from '../../src/governed-call/index.js';
import { resolveRailDestination } from '../../src/governed-call/rail-domains.js';

/**
 * AQ-FND M-3 inc-3b S1 — the CCTP burn builder. Every output must survive the REAL decoder and
 * classifier (strict-canonical, recipient pinned SELF, destinationCaller zero, maxFee<=amount),
 * so the builder can never emit a call the wall's off-chain mirror would refuse.
 */
const SELF = ('0x' + '55'.repeat(20)) as `0x${string}`;
const MESSENGER = ('0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa') as `0x${string}`;
const USDC = ('0x' + 'cc'.repeat(20)) as `0x${string}`;
const SEL_APPROVE = '0x095ea7b3';
const SEL_BURN = '0x8e0250ee';
const params = { self: SELF, tokenMessenger: MESSENGER, burnToken: USDC, destinationDomain: 6, amount: 2_000_000n };

const abi = parseAbi([
  'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)',
]);

function rule(target: string, selector: string, over: Partial<CallRule> = {}): CallRule {
  return { target, selector, recipientMode: 'self', spenderSet: [], perCallCap: '20000000', windowCapCall: '100000000', ...over };
}

function grant(): GrantState {
  const rules = [rule(USDC, SEL_APPROVE, { spenderSet: [MESSENGER] }), rule(MESSENGER, SEL_BURN)];
  return {
    rules: new Map(rules.map((r) => [ruleKey(r.target, r.selector), r])),
    budgets: new Map([[USDC.toLowerCase(), '100000000']]),
    allowlist: new Set<string>(),
    bridgeTargets: new Set([MESSENGER.toLowerCase()]),
  };
}

describe('buildCctpBurnCalls', () => {
  it('is deterministic and encodes the pinned shape', () => {
    const a = buildCctpBurnCalls(params);
    expect(a).toEqual(buildCctpBurnCalls({ ...params }));
    expect(a.approve.target).toBe(USDC);
    expect(a.burn.target).toBe(MESSENGER);
    expect(a.burn.data.slice(0, 10)).toBe(SEL_BURN);
    const dec = decodeFunctionData({ abi, data: a.burn.data });
    expect(dec.args[0]).toBe(2_000_000n);
    expect(dec.args[1]).toBe(6);
    expect(dec.args[2]).toBe(`0x${'00'.repeat(12)}${SELF.slice(2)}`);
    expect((dec.args[3] as string).toLowerCase()).toBe(USDC);
    expect(dec.args[4]).toBe(`0x${'00'.repeat(32)}`);
    expect(dec.args[5]).toBe(0n);
    expect(dec.args[6]).toBe(CCTP_STANDARD_FINALITY);
  });

  it('passes the real decoder: recipient SELF, domain 6 resolves to Base Sepolia, exact-amount approve', () => {
    const { approve, burn } = buildCctpBurnCalls(params);
    const d = decodeCall(MESSENGER, 0n, burn.data);
    expect(d.reject).toBeUndefined();
    expect(d.args.recipients).toEqual([SELF]);
    expect(d.args.spendToken).toBe(USDC);
    expect(d.args.amount).toBe(2_000_000n);
    expect(resolveRailDestination(d.args.bridgeDestination!)).toBe(84532);
    const ap = decodeCall(USDC, 0n, approve.data);
    expect(ap.args.spender).toBe(MESSENGER);
    expect(ap.args.amount).toBe(2_000_000n);
  });

  it('classifies as allowed bridge lane under the grants, and refuses without the rail allowlisted', () => {
    const { burn } = buildCctpBurnCalls(params);
    const d = decodeCall(MESSENGER, 0n, burn.data);
    expect(classify(d, grant(), SELF).lane).not.toBe('forbidden');
    const noBridge = { ...grant(), bridgeTargets: new Set<string>() };
    expect(classify(d, noBridge, SELF)).toMatchObject({ lane: 'forbidden', reason: 'bridge_not_allowlisted' });
  });

  it('refuses unusable inputs rather than emit them', () => {
    expect(() => buildCctpBurnCalls({ ...params, amount: 0n })).toThrow(/positive/);
    expect(() => buildCctpBurnCalls({ ...params, maxFee: 2_000_001n })).toThrow(/maxFee/);
    expect(() => buildCctpBurnCalls({ ...params, destinationDomain: -1 })).toThrow(/domain/);
  });

  it('an unknown destination domain decodes but resolves to null (the gate refuses it)', () => {
    const { burn } = buildCctpBurnCalls({ ...params, destinationDomain: 9 });
    const d = decodeCall(MESSENGER, 0n, burn.data);
    expect(resolveRailDestination(d.args.bridgeDestination!)).toBeNull();
  });
});
