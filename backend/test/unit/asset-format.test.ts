import { describe, it, expect } from 'vitest';
import { formatAssetAmount } from '../../src/asset/format.js';

describe('formatAssetAmount', () => {
  it('18dp token: exact, trimmed', () => {
    expect(formatAssetAmount(1_000_000_000_000_000_000n, 18, 'NOVL')).toBe('1 NOVL');
    expect(formatAssetAmount('10000000000000000', 18, 'NOVL')).toBe('0.01 NOVL');
    expect(formatAssetAmount(1_020_000_000_000_000_000n, 18, 'NOVL')).toBe('1.02 NOVL');
  });
  it('6dp token (USDC): 1000000 -> 1 USDC, not "1000000 base-units"', () => {
    expect(formatAssetAmount(1_000_000n, 6, 'USDC')).toBe('1 USDC');
    expect(formatAssetAmount(1_500_000n, 6, 'USDC')).toBe('1.5 USDC');
  });
  it('the live fleet dust: 1.02000000000283e18 never shows a long decimal', () => {
    expect(formatAssetAmount(1_020_000_000_000_283_000n, 18, '0G')).toBe('1.02 0G');
    expect(formatAssetAmount(2_830_000n, 18, '0G')).toBe('<0.000001 0G');
  });
  it('zero and huge values', () => {
    expect(formatAssetAmount(0n, 18, 'ETH')).toBe('0 ETH');
    expect(formatAssetAmount(123_456_789_012_345_678_901_234_567n, 18, 'X')).toBe('123456789.012345 X');
  });
  it('unknown decimals: honest units, never a guessed scale', () => {
    expect(formatAssetAmount(1_000_000n, null, null)).toBe('1000000 units');
    expect(formatAssetAmount(1_000_000n, null, '0x036c…cf7e')).toBe('1000000 units of 0x036c…cf7e');
  });
});
