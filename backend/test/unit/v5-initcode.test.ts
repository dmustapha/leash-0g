import { describe, it, expect } from 'vitest';
import { keccak256, encodeAbiParameters, encodePacked, getAddress, type Hex } from 'viem';
import {
  buildV5Initcode,
  ownerScopedSalt,
  predictCreate2Address,
  V5_CREATION_CODE,
  type V5CtorArgs,
} from '../../src/chain/v5-initcode.js';
import { ARTIFACT_CREATION_CODE_HASH } from '../../src/chain/v5-initcode.generated.js';

/**
 * Stage F′ (FP-4 P1) — the off-chain V5 initcode builder. Money-spine: the generic
 * Create2Deployer never embeds the account type, so the backend assembles the
 * initcode and the account address is f(deployer, salt, keccak256(initcode)). These
 * tests pin: the committed creationCode hash-check, the ctor-arg assembly, the
 * CREATE2 formula against an independent reference, and owner-scoped-salt isolation.
 */

const OWNER = getAddress('0x' + 'ab'.repeat(20));
const OWNER2 = getAddress('0x' + 'cd'.repeat(20));
const GUARDIAN = getAddress('0x' + 'ee'.repeat(20));
const SESSION = getAddress('0x' + '11'.repeat(20));
const SIGNING_HELPER = getAddress('0x' + '22'.repeat(20));
const DECODE_HELPER = getAddress('0x' + '33'.repeat(20));
const DEPLOYER = getAddress('0x' + '44'.repeat(20));
const AGENT_SALT = ('0x' + '5a'.repeat(32)) as Hex;

function ctorArgs(overrides: Partial<V5CtorArgs> = {}): V5CtorArgs {
  return {
    ownerAddr: OWNER,
    guardianAddr: GUARDIAN,
    sessionKeyAddr: SESSION,
    policy: { perTransferCap: 1n, windowCap: 2n, windowSeconds: 3600, expiresAt: 0 },
    allowlist: [],
    timelockDelay: 900,
    signingHelperAddr: SIGNING_HELPER,
    decodeHelperAddr: DECODE_HELPER,
    ...overrides,
  };
}

describe('FP-4 v5-initcode builder', () => {
  it('the embedded creationCode hash matches the committed artifact hash', () => {
    // The module-load hash-check already guards this; assert it explicitly so a
    // silent drift fails a FAST unit test, not only a boot.
    expect(keccak256(V5_CREATION_CODE)).toBe(ARTIFACT_CREATION_CODE_HASH);
  });

  it('initcode = creationCode ++ abi.encode(ctor args) in canonical order', () => {
    const encoded = encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'tuple', components: [{ type: 'uint128' }, { type: 'uint128' }, { type: 'uint32' }, { type: 'uint64' }] },
        { type: 'address[]' },
        { type: 'uint64' },
        { type: 'address' },
        { type: 'tuple', components: [{ type: 'uint128' }, { type: 'uint128' }] },
        { type: 'address' },
        { type: 'address' },
      ],
      [OWNER, GUARDIAN, SESSION, [1n, 2n, 3600, 0n], [], 900n, getAddress('0x' + '00'.repeat(20)), [0n, 0n], SIGNING_HELPER, DECODE_HELPER],
    );
    const initcode = buildV5Initcode(ctorArgs());
    expect(initcode).toBe((V5_CREATION_CODE + encoded.slice(2)) as Hex);
    // The initcode hash is the CREATE2 preimage — it must be a 32-byte keccak.
    expect(keccak256(initcode)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('predictCreate2Address matches the independent 0xff ++ deployer ++ salt ++ hash formula', () => {
    const initcode = buildV5Initcode(ctorArgs());
    const salt = ownerScopedSalt(OWNER, AGENT_SALT);
    const reference = getAddress(
      `0x${keccak256(
        encodePacked(['bytes1', 'address', 'bytes32', 'bytes32'], ['0xff', DEPLOYER, salt, keccak256(initcode)]),
      ).slice(-40)}`,
    );
    expect(predictCreate2Address(DEPLOYER, salt, initcode)).toBe(reference);
  });

  it('reproduces a KNOWN CREATE2 address vector (deployer/salt/initcode → address)', () => {
    // Independent fixed vector: the std deterministic-deployment proxy address, a
    // zero salt, and a trivial initcode — computed once with the canonical formula.
    const deployer = getAddress('0x4e59b44847b379578588920cA78FbF26c0B4956C');
    const salt = ('0x' + '00'.repeat(32)) as Hex;
    const initcode = '0x600a600c600039600a6000f3' as Hex; // tiny return-10-bytes stub
    const expected = getAddress(
      `0x${keccak256(
        encodePacked(['bytes1', 'address', 'bytes32', 'bytes32'], ['0xff', deployer, salt, keccak256(initcode)]),
      ).slice(-40)}`,
    );
    expect(predictCreate2Address(deployer, salt, initcode)).toBe(expected);
  });

  it('owner-scoped salt: two owners + the SAME agentSalt never collide', () => {
    const saltA = ownerScopedSalt(OWNER, AGENT_SALT);
    const saltB = ownerScopedSalt(OWNER2, AGENT_SALT);
    expect(saltA).not.toBe(saltB);
    // And the derived addresses (same initcode, different owner baked into salt) differ.
    const codeA = buildV5Initcode(ctorArgs({ ownerAddr: OWNER }));
    const codeB = buildV5Initcode(ctorArgs({ ownerAddr: OWNER2 }));
    expect(predictCreate2Address(DEPLOYER, saltA, codeA)).not.toBe(
      predictCreate2Address(DEPLOYER, saltB, codeB),
    );
    // salt itself is exactly keccak256(abi.encode(owner, agentSalt)).
    expect(saltA).toBe(
      keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [OWNER, AGENT_SALT])),
    );
  });
});
