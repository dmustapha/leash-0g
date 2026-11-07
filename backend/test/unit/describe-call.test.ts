import { describe, it, expect } from 'vitest';
import { describeDecodedCall, type CallLabeler } from '../../src/asset/describe-call.js';
import type { DecodedCall } from '../../src/governed-call/types.js';

const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
const ROUTER = '0x94cc0aac535ccdb3c01d6787d6413c739ae12bc4';
const labeler = (meta: { symbol: string; decimals: number } | null): CallLabeler => ({
  tokenMeta: async () => meta,
  nameOf: (a) => (a.toLowerCase() === ROUTER ? 'Uniswap router' : null),
});
const call = (over: Partial<DecodedCall['args']>, human: string, value = 0n): DecodedCall =>
  ({ target: USDC, value, data: '0x', selector: '0x095ea7b3', signature: 'approve(address,uint256)', humanReadable: human, args: { structured: true, amount: 1_000_000n, spendToken: USDC, recipients: [], ...over } });

describe('describeDecodedCall', () => {
  const raw = 'approve 1000000 base-units on 0x036c…cf7e (spender 0x94cc…2bc4)';
  it('the live ask: approve 1000000 on USDC for the router -> "approve 1 USDC for Uniswap router"', async () => {
    expect(await describeDecodedCall(call({ spender: ROUTER }, raw), 84532, labeler({ symbol: 'USDC', decimals: 6 }))).toBe('approve 1 USDC for Uniswap router');
  });
  it('unknown spender -> short address; unreadable token -> honest units, never a guessed scale', async () => {
    const out = await describeDecodedCall(call({ spender: '0x' + 'ab'.repeat(20) }, raw), 84532, labeler(null));
    expect(out).toMatch(/^approve 1000000 units of 0x036c…cf7e for 0xabab…abab$/);
  });
  it('a transfer names the recipient', async () => {
    expect(await describeDecodedCall(call({ recipients: [ROUTER] }, 'transfer 1000000 base-units on x → y'), 84532, labeler({ symbol: 'USDC', decimals: 6 }))).toBe('transfer 1 USDC to Uniswap router');
  });
  it('zero amount / approvedForAll fall back to the decoder text', async () => {
    expect(await describeDecodedCall(call({ amount: 0n }, 'x'), 84532, labeler(null))).toBe('x');
    expect(await describeDecodedCall(call({ approvedForAll: true }, 'y'), 84532, labeler(null))).toBe('y');
  });
});
