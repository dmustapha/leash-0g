import { describe, it, expect } from 'vitest';
import { toFunctionSelector, type AbiFunction } from 'viem';
import {
  factoryAbi,
  factoryV4Abi,
  factoryV4DeterministicAbi,
  create2DeployerAbi,
  registryAbi,
  leashAccountAbi,
  leashAccountV4Abi,
  leashAccountV5SigningAbi,
} from '../../src/chain/abis.js';

/**
 * Root-cause guard (FP-4 close-out, widened by the tear-apart TA-ABI-4): the hand-maintained
 * ABIs in `chain/abis.ts` silently drifted from the deployed contracts once — Slice-5 added a
 * `TokenCap[] caps` arg to `authorizeSigningIntent` (+ `kind`/`buyToken`/`caps` to
 * `proposeSigningGrantNested`), but the ABI kept the old shape, so the runtime arm encoded the
 * wrong selector and would revert on-chain. Nothing caught it because the live arm is [DEPLOY]-gated.
 *
 * The original guard only pinned the two V5 signing selectors. The drift CLASS, though, covers EVERY
 * hand-maintained write the backend encodes against a deployed contract (factories, create2 deployer,
 * registry, V4 govern-call tree, V5 signing). This test pins the on-chain selector of each of those
 * writes to the value computed from the VERBATIM compiled-artifact signature
 * (`forge inspect <C> methodIdentifiers`; the backend CI job has no artifact on disk → literal values).
 * If any contract signature changes, this fails loudly: update BOTH the selector here AND the
 * `parseAbi` entry in abis.ts, in the same change. (Web owner-write ABIs are guarded separately in web/.)
 */
const EXPECTED: Record<string, Record<string, `0x${string}`>> = {
  factoryAbi: {
    createAccount: '0xd2fe38c6',
  },
  factoryV4Abi: {
    createAccountV4: '0x6535c82d',
  },
  factoryV4DeterministicAbi: {
    createAccountV4: '0xdab94035',
    predictAccountV4: '0x194a757d',
  },
  create2DeployerAbi: {
    deploy: '0xcdcb760a',
    predict: '0xa2e8bb1b',
  },
  registryAbi: {
    register: '0x69d4d053',
    setStatus: '0xd896dd64',
  },
  leashAccountAbi: {
    execute: '0xb61d27f6',
    executeTokenTransfer: '0x80734baa',
    revoke: '0xb6549f75',
  },
  leashAccountV4Abi: {
    execute: '0xb61d27f6',
    executeTokenTransfer: '0x80734baa',
    executeCall: '0x9e5d4c49',
    proposeCallRule: '0xc510270e',
    applyCallRule: '0xee1d92bd',
    tightenCallRule: '0x5c7e95ec',
    removeCallSelector: '0x14443854',
    removeCallTarget: '0x2c63970c',
    authorizeOnce: '0x48586efe',
    proposeSpendBudget: '0xc2876455',
    applySpendBudget: '0x9d3a2e7f',
    tightenSpendBudget: '0x314e799e',
  },
  leashAccountV5SigningAbi: {
    authorizeSigningIntent: '0x3ad9b546',
    disarmSigningIntent: '0x25b53fc9',
    setCoSigner: '0x2199e6d3',
    applyCoSigner: '0xe262e507',
    proposeSigningGrantNested: '0x4c549cda',
    applySigningGrant: '0xe7070331',
    tightenSigningGrant: '0x76827501',
    removeSigningDescriptor: '0x3e80d9d2',
  },
};

const ABIS = {
  factoryAbi,
  factoryV4Abi,
  factoryV4DeterministicAbi,
  create2DeployerAbi,
  registryAbi,
  leashAccountAbi,
  leashAccountV4Abi,
  leashAccountV5SigningAbi,
} as const;

describe('chain/abis.ts — write-selector parity with the deployed contracts (TA-ABI-4)', () => {
  for (const [abiName, fns] of Object.entries(EXPECTED)) {
    const abi = ABIS[abiName as keyof typeof ABIS];
    for (const [name, selector] of Object.entries(fns)) {
      it(`${abiName}.${name} encodes the on-chain selector ${selector}`, () => {
        const fn = abi.find((f) => f.type === 'function' && f.name === name) as
          | AbiFunction
          | undefined;
        expect(fn, `${name} missing from ${abiName}`).toBeDefined();
        expect(toFunctionSelector(fn!)).toBe(selector);
      });
    }
  }
});
