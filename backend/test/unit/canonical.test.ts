import { describe, it, expect } from 'vitest';
import { canonicalJson } from '../../src/crypto/canonical.js';

describe('canonicalJson', () => {
  it('sorts object keys recursively', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('preserves array order', () => {
    expect(canonicalJson([{ b: 1, a: 2 }, 3])).toBe('[{"a":2,"b":1},3]');
  });

  it('is stable across key insertion order', () => {
    const x: Record<string, unknown> = {};
    x['z'] = 1;
    x['a'] = 2;
    const y: Record<string, unknown> = {};
    y['a'] = 2;
    y['z'] = 1;
    expect(canonicalJson(x)).toBe(canonicalJson(y));
  });

  it('drops undefined properties like JSON.stringify', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('serializes null, strings, booleans', () => {
    expect(canonicalJson({ a: null, b: 'x', c: true })).toBe('{"a":null,"b":"x","c":true}');
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson({ a: NaN })).toThrow();
    expect(() => canonicalJson({ a: Infinity })).toThrow();
  });
});
