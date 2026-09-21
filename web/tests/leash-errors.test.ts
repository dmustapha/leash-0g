// File: web/tests/leash-errors.test.ts
// P3C-6(ii) FE copy map: exactly the 17 LeashAccount error names, plain language only —
// no raw selectors ever reach a surface.
import { describe, expect, it } from 'vitest';
import { LEASH_ERROR_COPY, LEASH_ERROR_FALLBACK, plainLeashError } from '@/lib/leash-errors';

const EXPECTED_NAMES = [
  'NotOwner',
  'NotGuardianOrOwner',
  'NotSessionKey',
  'AccountRevoked',
  'AccountNotRevoked',
  'SessionExpired',
  'NotAllowlisted',
  'ZeroAddress',
  'CalldataForbidden',
  'OverPerTransferCap',
  'OverWindowCap',
  'CallFailed',
  'NothingPending',
  'TimelockNotElapsed',
  'NotLoosening',
  'NotTightening',
  'InvalidPolicy',
];

describe('leash-errors copy map', () => {
  it('has exactly 17 entries — every LeashAccount custom error, nothing else', () => {
    expect(Object.keys(LEASH_ERROR_COPY).sort()).toEqual([...EXPECTED_NAMES].sort());
    expect(Object.keys(LEASH_ERROR_COPY)).toHaveLength(17);
  });

  it('never outputs a raw selector or hex — plain language only', () => {
    for (const name of EXPECTED_NAMES) {
      const copy = plainLeashError(name);
      expect(copy.length).toBeGreaterThan(10);
      expect(copy).not.toMatch(/0x[0-9a-fA-F]{8}/);
      expect(copy).not.toContain(name); // copy is prose, not the identifier
    }
  });

  it('falls back to plain language for unknown names (still no selector)', () => {
    expect(plainLeashError('SomethingNew')).toBe(LEASH_ERROR_FALLBACK);
    expect(plainLeashError('0x12345678')).toBe(LEASH_ERROR_FALLBACK);
  });

  it('mirrors the backend copy for the boundary kinds the inbox shows', () => {
    expect(plainLeashError('OverWindowCap')).toBe(
      'That would go over the spending window cap — the window has to reset (or the owner raise it) first.',
    );
    expect(plainLeashError('SessionExpired')).toBe(
      "The agent's session has expired — re-arm it to allow acting again.",
    );
  });
});
