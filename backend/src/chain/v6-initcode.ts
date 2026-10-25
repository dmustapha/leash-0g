import { encodeAbiParameters, keccak256, getAddress, type Hex } from 'viem';
import { ARTIFACT_CREATION_CODE_HASH, V6_CREATION_CODE } from './v6-initcode.generated.js';

/**
 * AQ-FND — the V6 (multi-asset) account initcode builder, mirroring v5-initcode.ts verbatim
 * in shape: the generic `Create2Deployer` never references the account type; the backend
 * assembles `initcode = creationCode ++ abi.encode(InitConfig)` off-chain, and a module-load
 * hash-check refuses to run off a stale/tampered creationCode blob.
 *
 * V6 takes ONE struct argument (`LeashAccountV6.InitConfig`) — the arg order below must stay
 * byte-identical to the .sol struct. The FOUR pinned singletons (deployer + SigningLib +
 * DecodeLib + PolicyLib) plus the EnvelopeModule come from the operator-vetted ChainConfig,
 * never request input (RULING-B).
 */

export { V6_CREATION_CODE } from './v6-initcode.generated.js';

const embeddedHash = keccak256(V6_CREATION_CODE);
if (embeddedHash !== ARTIFACT_CREATION_CODE_HASH) {
  throw new Error(
    `v6-initcode: creationCode hash ${embeddedHash} != committed ${ARTIFACT_CREATION_CODE_HASH} — run scripts/gen-v6-initcode.mjs`,
  );
}

export interface V6AssetPolicy {
  enabled: boolean;
  perTransferCap: bigint;
  windowCap: bigint;
  windowSeconds: number;
}

export interface V6CtorArgs {
  ownerAddr: string;
  guardianAddr: string;
  sessionKeyAddr: string;
  session: { ruleWindowSeconds: number; expiresAt: number };
  nativePolicy: V6AssetPolicy;
  initialAssets: string[];
  initialAssetPolicies: V6AssetPolicy[];
  initialAllowlist: string[];
  timelockDelay: number;
  /** RULING-B: all five from ChainConfig — never the caller. */
  signingHelperAddr: string;
  decodeHelperAddr: string;
  policyHelperAddr: string;
  envelopeModuleAddr: string;
}

const ASSET_POLICY_COMPONENTS = [
  { type: 'bool' },
  { type: 'uint128' },
  { type: 'uint128' },
  { type: 'uint32' },
] as const;

/** viem ABI spec for the single InitConfig struct param (matches the .sol field order). */
const V6_CTOR_ABI = [
  {
    type: 'tuple',
    components: [
      { type: 'address' }, // owner
      { type: 'address' }, // guardian
      { type: 'address' }, // sessionKey
      { type: 'tuple', components: [{ type: 'uint32' }, { type: 'uint64' }] }, // session
      { type: 'tuple', components: ASSET_POLICY_COMPONENTS }, // nativePolicy
      { type: 'address[]' }, // initialAssets
      { type: 'tuple[]', components: ASSET_POLICY_COMPONENTS }, // initialAssetPolicies
      { type: 'address[]' }, // initialAllowlist
      { type: 'uint64' }, // timelockDelay
      { type: 'address' }, // signingHelper
      { type: 'address' }, // decodeHelper
      { type: 'address' }, // policyHelper
      { type: 'address' }, // envelopeModule
    ],
  },
] as const;

function assetTuple(p: V6AssetPolicy): readonly [boolean, bigint, bigint, number] {
  return [p.enabled, p.perTransferCap, p.windowCap, p.windowSeconds];
}

function encodeV6CtorArgs(args: V6CtorArgs): Hex {
  if (args.initialAssets.length !== args.initialAssetPolicies.length) {
    throw new Error('v6-initcode: initialAssets/initialAssetPolicies length mismatch');
  }
  return encodeAbiParameters(V6_CTOR_ABI, [
    [
      getAddress(args.ownerAddr),
      getAddress(args.guardianAddr),
      getAddress(args.sessionKeyAddr),
      [args.session.ruleWindowSeconds, BigInt(args.session.expiresAt)],
      assetTuple(args.nativePolicy),
      args.initialAssets.map((a) => getAddress(a)),
      args.initialAssetPolicies.map(assetTuple),
      args.initialAllowlist.map((a) => getAddress(a)),
      BigInt(args.timelockDelay),
      getAddress(args.signingHelperAddr),
      getAddress(args.decodeHelperAddr),
      getAddress(args.policyHelperAddr),
      getAddress(args.envelopeModuleAddr),
    ],
  ]);
}

/** The full CREATE2 initcode for a V6 account (keccak = preimage of the address). */
export function buildV6Initcode(args: V6CtorArgs): Hex {
  return (V6_CREATION_CODE + encodeV6CtorArgs(args).slice(2)) as Hex;
}

export function v6InitCodeHash(args: V6CtorArgs): Hex {
  return keccak256(buildV6Initcode(args));
}
