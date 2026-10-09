import { describe, it, expect } from 'vitest';
import { toFunctionSelector } from 'viem';
import { leashAccountV5SigningAbi } from '../../src/chain/abis.js';

/**
 * Root-cause guard (FP-4 close-out): the hand-maintained `leashAccountV5SigningAbi` silently drifted from
 * the deployed `LeashAccountV5` once — Slice-5 added a `TokenCap[] caps` arg to `authorizeSigningIntent`
 * (and `kind`/`buyToken` + `caps` to `proposeSigningGrantNested`), but the ABI kept the old shape, so the
 * runtime arm encoded the wrong selector and would revert on-chain. Nothing caught it because the live arm
 * is `[DEPLOY]`-gated.
 *
 * This test pins the on-chain selectors of the functions the backend actually CALLS as a write, computed
 * from the verbatim contract signatures (ground truth = the compiled artifact, which the backend CI job
 * does not have on disk — hence the literal values). If the contract signature changes, this fails loudly:
 * update BOTH the contract-derived selector here AND the parseAbi entry in abis.ts, in the same change.
 */
const EXPECTED_SELECTORS: Record<string, `0x${string}`> = {
  // authorizeSigningIntent(uint256,bytes32[],(address,uint128)[],bytes,bytes)
  authorizeSigningIntent: '0x3ad9b546',
  // proposeSigningGrantNested((uint256,bytes32,bytes32,uint8,uint8,uint8,uint8,uint8,bytes32,uint8,uint8,address,uint128,uint64,uint8,address),address[],(address,uint128)[])
  proposeSigningGrantNested: '0x4c549cda',
};

describe('leashAccountV5SigningAbi — selector parity with the deployed contract', () => {
  for (const [name, selector] of Object.entries(EXPECTED_SELECTORS)) {
    it(`${name} encodes the on-chain selector ${selector}`, () => {
      const fn = leashAccountV5SigningAbi.find(
        (f): f is Extract<typeof f, { type: 'function' }> => f.type === 'function' && f.name === name,
      );
      expect(fn, `${name} missing from leashAccountV5SigningAbi`).toBeDefined();
      expect(toFunctionSelector(fn!)).toBe(selector);
    });
  }
});
