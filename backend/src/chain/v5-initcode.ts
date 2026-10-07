import { encodeAbiParameters, keccak256, getAddress, encodePacked, type Hex } from 'viem';
import { ARTIFACT_CREATION_CODE_HASH, V5_CREATION_CODE } from './v5-initcode.generated.js';

/**
 * Stage F′ (FP-4 P1) — the V5 account initcode builder (R-5). The generic
 * `Create2Deployer` (contracts/src/Create2Deployer.sol) NEVER references the
 * account type — that is what keeps it EIP-170-safe — so the backend assembles the
 * account initcode OFF-CHAIN: `initcode = creationCode ++ abi.encode(ctor args)`.
 *
 * The typing the retired on-chain factory gave for free now lives here: the ctor
 * arg ORDER (below) + the committed creationCode are the single source of truth,
 * and a module-load hash-check (fail-loud, config.ts ethos) refuses to run off a
 * stale or tampered creationCode blob — money code is never silently drifted.
 */

// Re-export so the committed creationCode has one import surface.
export { V5_CREATION_CODE } from './v5-initcode.generated.js';

/**
 * Fail-loud drift tripwire: recompute the hash from the embedded constant and
 * assert it against the hash the generator recorded from the Foundry artifact. A
 * creationCode edit that bypasses `scripts/gen-v5-initcode.mjs` fails to LOAD the
 * module (the whole backend refuses to boot) rather than minting off a stale blob.
 */
const embeddedHash = keccak256(V5_CREATION_CODE);
if (embeddedHash !== ARTIFACT_CREATION_CODE_HASH) {
  throw new Error(
    `v5-initcode: creationCode hash ${embeddedHash} != committed ${ARTIFACT_CREATION_CODE_HASH} — run scripts/gen-v5-initcode.mjs`,
  );
}

/** The ZERO address — "native-only account" in the constructor wire. */
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

/**
 * The V5 constructor arg tuple, in the EXACT order of LeashAccountV5's constructor
 * (owner, guardian, sessionKey, Policy, allowlist, timelockDelay, settlementToken,
 * TokenPolicy, signingHelper, decodeHelper). The three helper/deployer singletons
 * come from the operator-vetted ChainConfig, NEVER request input (RULING-B).
 */
export interface V5CtorArgs {
  ownerAddr: string;
  guardianAddr: string;
  sessionKeyAddr: string;
  policy: { perTransferCap: bigint; windowCap: bigint; windowSeconds: number; expiresAt: number };
  allowlist: string[];
  timelockDelay: number;
  settlementToken?: string;
  tokenPolicy?: { perTransferCapToken: bigint; windowCapToken: bigint };
  /** RULING-B: from ChainConfig.signingHelperAddr — never the caller. */
  signingHelperAddr: string;
  /** RULING-B: from ChainConfig.decodeHelperAddr — never the caller. */
  decodeHelperAddr: string;
}

/** viem ABI spec for the V5 constructor params (matches the .sol arg order). */
const V5_CTOR_ABI = [
  { type: 'address' },
  { type: 'address' },
  { type: 'address' },
  {
    type: 'tuple',
    components: [
      { type: 'uint128' },
      { type: 'uint128' },
      { type: 'uint32' },
      { type: 'uint64' },
    ],
  },
  { type: 'address[]' },
  { type: 'uint64' },
  { type: 'address' },
  { type: 'tuple', components: [{ type: 'uint128' }, { type: 'uint128' }] },
  { type: 'address' },
  { type: 'address' },
] as const;

/** ABI-encode the V5 constructor args in canonical order. */
function encodeV5CtorArgs(args: V5CtorArgs): Hex {
  return encodeAbiParameters(V5_CTOR_ABI, [
    getAddress(args.ownerAddr),
    getAddress(args.guardianAddr),
    getAddress(args.sessionKeyAddr),
    [
      args.policy.perTransferCap,
      args.policy.windowCap,
      args.policy.windowSeconds,
      BigInt(args.policy.expiresAt),
    ],
    args.allowlist.map((a) => getAddress(a)),
    BigInt(args.timelockDelay),
    getAddress(args.settlementToken ?? ZERO_ADDR),
    [args.tokenPolicy?.perTransferCapToken ?? 0n, args.tokenPolicy?.windowCapToken ?? 0n],
    getAddress(args.signingHelperAddr),
    getAddress(args.decodeHelperAddr),
  ]);
}

/**
 * The full CREATE2 initcode for a V5 account: `creationCode ++ abi.encode(ctor)`.
 * This is the EXACT bytes the generic deployer's `create2` runs — its keccak256 is
 * a preimage of the account address (front-run-safe by construction).
 */
export function buildV5Initcode(args: V5CtorArgs): Hex {
  return (V5_CREATION_CODE + encodeV5CtorArgs(args).slice(2)) as Hex;
}

/**
 * R-4 owner-scoped salt — computed in the BACKEND so the generic deployer stays
 * pure. `salt = keccak256(abi.encode(owner, agentSalt))`: baking the owner in
 * preserves the front-run/collision safety the retired owner-scoped factory gave.
 * `agentSalt` is the per-agent random/reused salt (server-generated, never caller
 * or model text), reused verbatim cross-chain so the account lands at one address.
 */
export function ownerScopedSalt(ownerAddr: string, agentSalt: string): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'bytes32' }],
      [getAddress(ownerAddr), agentSalt as Hex],
    ),
  );
}

/**
 * The CREATE2 address for `initcode` under `deployerAddr` with `salt`:
 * `keccak256(0xff ++ deployer ++ salt ++ keccak256(initcode))[12:]`. Pure off-chain
 * derivation — the home of `predictAccountV5`; cross-checked against the on-chain
 * `Create2Deployer.predict` read at deploy time.
 */
export function predictCreate2Address(deployerAddr: string, salt: Hex, initcode: Hex): Hex {
  const initCodeHash = keccak256(initcode);
  const digest = keccak256(
    encodePacked(
      ['bytes1', 'address', 'bytes32', 'bytes32'],
      ['0xff', getAddress(deployerAddr), salt, initCodeHash],
    ),
  );
  return getAddress(`0x${digest.slice(-40)}`);
}
