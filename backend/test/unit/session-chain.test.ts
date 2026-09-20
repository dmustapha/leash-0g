import { describe, it, expect } from 'vitest';
import { assertReceiptSuccess } from '../../src/runtime/session-chain.js';

const TX = '0x' + 'ab'.repeat(32);

describe('assertReceiptSuccess', () => {
  it('passes on a successful receipt', () => {
    expect(() => assertReceiptSuccess('success', TX)).not.toThrow();
  });

  it('throws on a reverted receipt so the transfer is never recorded as acted', () => {
    expect(() => assertReceiptSuccess('reverted', TX)).toThrow(`execute transfer reverted on-chain: ${TX}`);
  });
});
