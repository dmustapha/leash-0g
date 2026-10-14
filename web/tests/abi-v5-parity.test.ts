import { describe, it, expect } from 'vitest';
import { toFunctionSelector, type AbiFunction } from 'viem';

import {
  LEASH_ACCOUNT_V5_ABI,
  accountAbiForVersion,
} from '../lib/abi/leashAccountV5';
import { LEASH_ACCOUNT_V4_ABI } from '../lib/abi/leashAccountV4';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import artifact from '../../contracts/out/LeashAccountV5.sol/LeashAccountV5.json';

/**
 * Root-cause guard (Phase A2, mirrors backend test/unit/abis-signing-parity.test.ts for the web).
 * The web owner-write ABI is hand-maintained via viem `parseAbi`. If a V5 contract signature changes
 * (as Slice-5 added `caps` to the signing writes on the backend), the FE would encode the wrong
 * selector and the owner arm would revert on-chain. This pins every V5 owner-write fragment's
 * computed selector to the VERBATIM compiled Foundry artifact — the single source of truth — so any
 * drift fails loudly here instead of silently at arm time. Web ABIs are guarded here; backend ABIs
 * in their own suite.
 */

// The full V5 owner-write set the FE encodes (shared V4 grammar + V5 band + V5 signing writes).
const WRITE_FNS = [
  // shared V4 grammar
  'execute',
  'executeTokenTransfer',
  'executeCall',
  'proposeCallRule',
  'applyCallRule',
  'tightenCallRule',
  'removeCallSelector',
  'removeCallTarget',
  'authorizeOnce',
  'proposeSpendBudget',
  'applySpendBudget',
  'tightenSpendBudget',
  // band arm/propose/apply
  'proposePriceBand',
  'applyPriceBand',
  'tightenPriceBand',
  'enableRequireBandForSwap',
  // V5-only governed-signing writes
  'authorizeSigningIntent',
  'disarmSigningIntent',
  'setCoSigner',
  'applyCoSigner',
  'proposeSigningGrantNested',
  'applySigningGrant',
  'tightenSigningGrant',
  'removeSigningDescriptor',
] as const;

const artifactSelector = (name: string): `0x${string}` => {
  const fn = (artifact.abi as AbiFunction[]).find(
    (f) => f.type === 'function' && f.name === name,
  );
  expect(fn, `${name} missing from compiled LeashAccountV5 artifact`).toBeDefined();
  return toFunctionSelector(fn!);
};

const webSelector = (name: string): `0x${string}` => {
  const fn = LEASH_ACCOUNT_V5_ABI.find(
    (f) => f.type === 'function' && f.name === name,
  ) as AbiFunction | undefined;
  expect(fn, `${name} missing from LEASH_ACCOUNT_V5_ABI`).toBeDefined();
  return toFunctionSelector(fn!);
};

describe('leashAccountV5 — write-selector parity with the compiled LeashAccountV5 artifact', () => {
  for (const name of WRITE_FNS) {
    it(`${name} encodes the on-chain selector`, () => {
      expect(webSelector(name)).toBe(artifactSelector(name));
    });
  }

  it('the version selector returns the V4 ABI for a V4 account', () => {
    expect(accountAbiForVersion(4)).toBe(LEASH_ACCOUNT_V4_ABI);
  });

  it('the version selector returns the V5 superset for a V5 account', () => {
    expect(accountAbiForVersion(5)).toBe(LEASH_ACCOUNT_V5_ABI);
  });

  it('V5 is a superset: every V4 fragment is present in the V5 ABI', () => {
    const v5Names = new Set(
      LEASH_ACCOUNT_V5_ABI.filter((f) => f.type === 'function').map(
        (f) => (f as AbiFunction).name,
      ),
    );
    for (const f of LEASH_ACCOUNT_V4_ABI) {
      if (f.type === 'function') expect(v5Names.has(f.name)).toBe(true);
    }
  });
});
