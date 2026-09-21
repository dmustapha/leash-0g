import { describe, it, expect } from 'vitest';
import { encodeErrorResult } from 'viem';
import { leashAccountAbi } from '../../src/chain/abis.js';
import { decodeLeashError, LEASH_ERROR_NAMES, plainLeashError } from '../../src/chain/errors.js';
import { BoundaryRegistry, policyFingerprint } from '../../src/runtime/boundary.js';
import type { PolicySnapshot } from '../../src/runtime/prompt.js';

/**
 * P3C-6(ii): decode ALL 17 LeashAccount errors from REAL revert-data fixtures
 * (spec §8 contracts row) + the plain-language copy map. Plus the (iii)
 * boundary clear-condition unit coverage.
 */

const errorAbi = leashAccountAbi.filter((i) => i.type === 'error');

// (name, args) fixture per error — args typed per the contract signatures.
const FIXTURES: Array<{ name: string; args: unknown[] }> = [
  { name: 'NotOwner', args: [] },
  { name: 'NotGuardianOrOwner', args: [] },
  { name: 'NotSessionKey', args: [] },
  { name: 'AccountRevoked', args: [] },
  { name: 'AccountNotRevoked', args: [] },
  { name: 'SessionExpired', args: [] },
  { name: 'NotAllowlisted', args: ['0x9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c'] },
  { name: 'ZeroAddress', args: [] },
  { name: 'CalldataForbidden', args: [] },
  { name: 'OverPerTransferCap', args: [20_000_000_000_000_000n, 10_000_000_000_000_000n] },
  { name: 'OverWindowCap', args: [40_000_000_000_000_000n, 30_000_000_000_000_000n] },
  { name: 'CallFailed', args: [] },
  { name: 'NothingPending', args: [] },
  { name: 'TimelockNotElapsed', args: [1_800_000_000n] },
  { name: 'NotLoosening', args: [] },
  { name: 'NotTightening', args: [] },
  { name: 'InvalidPolicy', args: [] },
];

describe('P3C-6(ii) — decodeLeashError over all 17 errors', () => {
  it('the fixture list covers exactly the contract error set (pin: 17)', () => {
    expect(LEASH_ERROR_NAMES).toHaveLength(17);
    expect([...FIXTURES.map((f) => f.name)].sort()).toEqual([...LEASH_ERROR_NAMES].sort());
  });

  for (const fixture of FIXTURES) {
    it(`decodes ${fixture.name} from real revert data with plain-language copy`, () => {
      const data = encodeErrorResult({
        abi: errorAbi,
        errorName: fixture.name,
        args: fixture.args,
      } as unknown as Parameters<typeof encodeErrorResult>[0]);
      // The shape the act path actually sees: an Error whose message carries
      // the revert data (RPC / viem message formats vary; the decoder greps).
      const decoded = decodeLeashError(new Error(`execution reverted: ${data}`));
      expect(decoded?.errorName).toBe(fixture.name);
      expect(decoded?.plain).toBeTruthy();
      // Never a raw 4-byte selector (a full ADDRESS in the copy is fine —
      // the lookahead rejects exactly-8-hex-digit tokens only).
      expect(decoded?.plain).not.toMatch(/0x[0-9a-f]{8}(?![0-9a-f])/i);
    });
  }

  it('bare 4-byte selector in a message still resolves the error name', () => {
    // AccountRevoked selector observed live in Phase-1 (DEPLOYMENTS.md).
    const decoded = decodeLeashError(new Error('execution reverted with reason 0x74b17b2b'));
    expect(decoded?.errorName).toBe('AccountRevoked');
  });

  it('non-Leash errors return null (never a fabricated decode)', () => {
    expect(decodeLeashError(new Error('ECONNREFUSED'))).toBeNull();
    expect(decodeLeashError(new Error('execution reverted: 0xdeadbeef'))).toBeNull();
  });

  it('every error name has non-fallback plain copy', () => {
    for (const name of LEASH_ERROR_NAMES) {
      expect(plainLeashError(name, [])).not.toBe('The account contract refused this action.');
    }
  });
});

describe('P3C-6(iii) — boundary clear conditions', () => {
  const NOW = 1_800_000_000;
  function snapshot(overrides: Partial<PolicySnapshot> = {}): PolicySnapshot {
    return {
      perTransferCapWei: '10',
      windowCapWei: '30',
      windowSeconds: 3600,
      expiresAt: NOW + 86_400,
      allowlist: ['0xaa'],
      revoked: false,
      spentInWindowWei: '30',
      remainingWindowWei: '0',
      windowResetsAtUnix: NOW + 3600,
      ...overrides,
    };
  }
  function activate(reg: BoundaryRegistry, policy: PolicySnapshot, clearsAt: number | null, name = 'OverWindowCap') {
    reg.set('agent-1', {
      errorName: name as 'OverWindowCap',
      clearsAtUnix: clearsAt,
      policyFingerprint: policyFingerprint(policy),
      dedupKey: 'k',
      activatedAtUnix: NOW,
    });
  }

  it('clears when the window reset time passes', () => {
    const reg = new BoundaryRegistry();
    const p = snapshot();
    activate(reg, p, NOW + 3600);
    expect(reg.refresh('agent-1', p, NOW + 100).status).toBe('active');
    expect(reg.refresh('agent-1', p, NOW + 3600).status).toBe('cleared');
    expect(reg.refresh('agent-1', p, NOW + 3601).status).toBe('none');
  });

  it('clears on ANY policy change (fingerprint)', () => {
    const reg = new BoundaryRegistry();
    const p = snapshot();
    activate(reg, p, NOW + 3600);
    const loosened = snapshot({ windowCapWei: '60' });
    expect(reg.refresh('agent-1', loosened, NOW + 10).status).toBe('cleared');
  });

  it('SessionExpired clears on re-arm (expiresAt back in the future)', () => {
    const reg = new BoundaryRegistry();
    const expired = snapshot({ expiresAt: NOW - 10 });
    activate(reg, expired, null, 'SessionExpired');
    expect(reg.refresh('agent-1', expired, NOW).status).toBe('active');
    // Re-arm changes expiresAt — fingerprint AND rearm both clear; assert via
    // a fingerprint-stable rearm is impossible (expiresAt is in the print),
    // which is fine: any re-arm IS a policy change. Direct rearm check:
    const rearmed = { ...expired, expiresAt: NOW + 1000 };
    activate(reg, rearmed, null, 'SessionExpired'); // print matches rearmed
    expect(reg.refresh('agent-1', rearmed, NOW).status).toBe('cleared');
  });
});
