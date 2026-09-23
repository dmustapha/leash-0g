import { describe, it, expect } from 'vitest';
import { formatAsset } from '../../src/util/format.js';

// The bug Dami caught: a 6-decimal token fee rendered via the 18-decimal 0G
// formatter showed "0.00 0G". formatAsset must label the TRUE asset.
describe('formatAsset — detect + label the settlement asset', () => {
  it('renders a 6dp token by its own decimals + symbol', () => {
    expect(formatAsset('2000000', 6, 'TestUSD')).toBe('2 TestUSD');
    expect(formatAsset('2500000', 6, 'USDC')).toBe('2.5 USDC');
    expect(formatAsset('1', 6, 'USDC')).toBe('0.000001 USDC');
  });

  it('renders native 0G at 18 decimals', () => {
    expect(formatAsset('500000000000000000', 18, '0G')).toBe('0.5 0G');
    expect(formatAsset('2000000', 18, '0G')).toBe('0.000000000002 0G'); // the value that WAS mislabeled "0.00 0G"
  });

  it('trims trailing zeros and handles whole numbers', () => {
    expect(formatAsset('10000000', 6, 'USDC')).toBe('10 USDC');
    expect(formatAsset('0', 6, 'USDC')).toBe('0 USDC');
  });

  it('unknown metadata falls back to honest raw base units (never a wrong asset)', () => {
    expect(formatAsset('2000000', null, null)).toBe('2000000 units');
    expect(formatAsset('2000000', 6, null)).toBe('2000000 units');
  });
});
