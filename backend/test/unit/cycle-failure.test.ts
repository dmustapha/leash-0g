import { describe, it, expect } from 'vitest';
import { HttpRequestError, TimeoutError, ContractFunctionRevertedError, BaseError } from 'viem';
import { describeCycleFailure, rawErrorText, MAX_RAW_ERROR } from '../../src/runtime/cycle-failure.js';

const URL0G = 'https://evmrpc-testnet.0g.ai/';
const noLeak = (s: string): void => {
  expect(s).not.toMatch(/\n/);
  expect(s).not.toMatch(/https?:\/\//);
  expect(s).not.toMatch(/Request body|Contract Call|0x[0-9a-fA-F]{20,}|Version: viem/);
};

describe('describeCycleFailure', () => {
  it('maps an inference-gateway refusal', () => {
    expect(describeCycleFailure(new Error('gateway refused inference: status 502'))).toBe(
      "The reasoning service didn't answer (status 502). It will try again.",
    );
  });

  it('collapses the real viem HTTP dump to one line naming only the host', () => {
    const err = new HttpRequestError({ url: URL0G, body: { method: 'eth_getBalance', params: ['0x' + 'e5'.repeat(20)] }, details: 'fetch failed' });
    expect(err.message).toMatch(/Request body/); // the raw form IS ugly
    const plain = describeCycleFailure(err);
    expect(plain).toBe("The network node (evmrpc-testnet.0g.ai) didn't respond. It will try again.");
    noLeak(plain);
  });

  it('maps a viem timeout the same way', () => {
    const plain = describeCycleFailure(new TimeoutError({ url: URL0G, body: { method: 'eth_call' } }));
    expect(plain).toBe("The network node (evmrpc-testnet.0g.ai) didn't respond. It will try again.");
  });

  it('finds the HTTP error when it is wrapped as a cause', () => {
    const inner = new HttpRequestError({ url: URL0G, body: {} });
    const wrapped = new BaseError('outer failure', { cause: inner });
    expect(describeCycleFailure(wrapped)).toContain('evmrpc-testnet.0g.ai');
  });

  it('turns a contract revert into one line with no call block or addresses', () => {
    const revert = new ContractFunctionRevertedError({
      abi: [{ type: 'function', name: 'spendBudget', stateMutability: 'view', inputs: [], outputs: [] }],
      functionName: 'spendBudget',
    });
    const plain = describeCycleFailure(revert);
    expect(plain).toMatch(/^The chain refused a call: /);
    expect(plain).toMatch(/spendBudget/);
    noLeak(plain);
  });

  it('drops the retry promise when the agent is being paused', () => {
    expect(describeCycleFailure(new Error('gateway refused inference: status 502'), { retrying: false })).toBe(
      "The reasoning service didn't answer (status 502).",
    );
  });

  it('falls back to the first line, capped, for anything else', () => {
    expect(describeCycleFailure(new Error('boom\nstack-ish second line'))).toBe('boom');
    expect(describeCycleFailure('plain string')).toBe('plain string');
    expect(describeCycleFailure(new Error('x'.repeat(500))).length).toBeLessThanOrEqual(160);
    expect(describeCycleFailure(new Error(''))).toBe('An unexpected error occurred.');
  });
});

describe('rawErrorText', () => {
  it('keeps the whole original message up to the cap', () => {
    const err = new HttpRequestError({ url: URL0G, body: { method: 'eth_getBalance' } });
    expect(rawErrorText(err)).toBe(err.message);
    expect(rawErrorText(new Error('y'.repeat(5000))).length).toBe(MAX_RAW_ERROR);
  });
});
