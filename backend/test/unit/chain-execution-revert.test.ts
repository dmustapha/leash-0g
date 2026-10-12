// Create-error honesty: a chain-side execution revert (the deploy reverted
// on-chain / in simulation) must surface as a typed 503 `chain_deploy_reverted`,
// not an opaque 500 "internal error". isChainExecutionRevert is the classifier.
// (A 2026-10-12 transient 0G create-revert read as "internal error" and cost hours.)
import { describe, it, expect } from 'vitest';
import { isChainExecutionRevert, isInsufficientFunds } from '../../src/api/owner-routes.js';

describe('isChainExecutionRevert', () => {
  it('matches a viem ContractFunctionExecutionError', () => {
    const err = new Error('The contract function "createAccountV4" reverted.');
    err.name = 'ContractFunctionExecutionError';
    expect(isChainExecutionRevert(err)).toBe(true);
  });

  it('matches "execution reverted" in the message', () => {
    expect(isChainExecutionRevert(new Error('execution reverted'))).toBe(true);
  });

  it('matches shortMessage and walks the cause chain', () => {
    const inner = new Error('x');
    inner.name = 'ExecutionRevertedError';
    const outer = new Error('deploy failed');
    (outer as Error & { cause: unknown }).cause = inner;
    expect(isChainExecutionRevert(outer)).toBe(true);
    const sm = new Error('wrapper');
    (sm as Error & { shortMessage: string }).shortMessage = 'Execution reverted for an unknown reason.';
    expect(isChainExecutionRevert(sm)).toBe(true);
  });

  it('does NOT match an ops-underfunded error (that routes to 409, checked first)', () => {
    const under = new Error('insufficient funds for gas * price + value');
    expect(isChainExecutionRevert(under)).toBe(false);
    expect(isInsufficientFunds(under)).toBe(true);
  });

  it('does NOT match unrelated errors; bounded walk terminates on a self-cause loop', () => {
    expect(isChainExecutionRevert(new Error('ECONNREFUSED'))).toBe(false);
    expect(isChainExecutionRevert('execution reverted')).toBe(false); // non-Error primitive: loop never starts
    const loop = new Error('nope');
    (loop as Error & { cause: unknown }).cause = loop;
    expect(isChainExecutionRevert(loop)).toBe(false);
  });
});
