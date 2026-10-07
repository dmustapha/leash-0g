import { keccak256, toBytes, concat, encodeAbiParameters, getTypesForEIP712Domain, type Hex } from 'viem';
import type { Eip712Domain, Eip712Field, SigningDescriptor } from './types.js';

/**
 * Reviewed signing descriptor registry (FP-2, SD-F6/F9) — the authority surface
 * the engine trusts, config-extensible exactly like the on-chain registry: adding
 * a protocol is a descriptor + an owner grant, NO code change. A descriptor the
 * registry does not know is `unknown_descriptor` → refused (default-deny, never
 * inferred — the 00 §9 floor). Mirror of `tool-use/tool-registry.ts`.
 *
 * Every descriptor is validated at REVIEW TIME by `assertDescriptor` — N-01 +
 * N-02 (the FP-1 security-auditor's fail-closed engine assertions, D-FP1-3): a
 * mis-authored descriptor must be a LOUD reviewer error PRE-GRANT, never a silent
 * on-chain "never validates". The registry computes the `domainSeparator` +
 * `typeHash` the owner's on-chain `proposeSigningGrant` must store, so the
 * engine's reconstruction and the wall's stored values are guaranteed identical.
 */

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

/**
 * The static ABI value types EIP-712 encodes as a single 32-byte word. N-02: a
 * descriptor field MUST be one of these — a dynamic (`string`/`bytes`), array
 * (`…[]`) or nested-struct (tuple) field cannot be reconstructed by the on-chain
 * `keccak256(typeHash ‖ fields)` flat-word decode and is rejected at review time.
 */
function isStaticWordType(type: string): boolean {
  if (type === 'address' || type === 'bool') return true;
  // bytes1..bytes32 (NOT bare `bytes`, which is dynamic).
  if (/^bytes([1-9]|[12][0-9]|3[0-2])$/.test(type)) return true;
  // uintN / intN where N is a multiple of 8 in [8,256].
  const m = /^(u?int)(\d+)$/.exec(type);
  if (m) {
    const bits = Number(m[2]);
    return bits >= 8 && bits <= 256 && bits % 8 === 0;
  }
  return false;
}

export class DescriptorError extends Error {
  constructor(
    public readonly descriptorKey: string,
    public readonly code:
      | 'domain_unbound_chainid'
      | 'domain_unbound_contract'
      | 'dynamic_field'
      | 'no_fields'
      | 'too_many_fields'
      | 'unknown_role_field'
      | 'role_type_mismatch'
      | 'role_index_alias',
    message: string,
  ) {
    super(`descriptor ${descriptorKey}: ${message}`);
    this.name = 'DescriptorError';
  }
}

/**
 * N-01 + N-02 descriptor review. Throws a LOUD `DescriptorError` on any defect so
 * a mis-authored descriptor can never reach a grant. Called by `createRegistry`
 * (every registry descriptor is asserted) AND by the owner `signing/rule` route
 * before it writes a grant. Fail-closed: anything it does not positively accept
 * is rejected.
 */
export function assertDescriptor(d: SigningDescriptor): void {
  // N-01: the domain MUST bind chainId + verifyingContract (replay immunity).
  if (!d.domain.chainId || d.domain.chainId <= 0) {
    throw new DescriptorError(d.key, 'domain_unbound_chainid', 'domain.chainId must be a positive chain id (N-01)');
  }
  const vc = d.domain.verifyingContract?.toLowerCase();
  if (!vc || !/^0x[0-9a-f]{40}$/.test(vc) || vc === ZERO_ADDR) {
    throw new DescriptorError(
      d.key,
      'domain_unbound_contract',
      'domain.verifyingContract must be a nonzero 0x address (N-01)',
    );
  }
  // numFields bounds mirror the on-chain `proposeSigningGrant` (1..32).
  if (d.fields.length === 0) throw new DescriptorError(d.key, 'no_fields', 'descriptor has no fields');
  if (d.fields.length > 32) throw new DescriptorError(d.key, 'too_many_fields', 'descriptor exceeds 32 fields');
  // N-02: every field is a static 32-byte word (no dynamic/nested/array).
  for (const f of d.fields) {
    if (!isStaticWordType(f.type)) {
      throw new DescriptorError(
        d.key,
        'dynamic_field',
        `field "${f.name}" type "${f.type}" is not a static 32-byte word (N-02)`,
      );
    }
  }
  // Role fields must exist and carry the right static type.
  const si = fieldIndex(d, d.roles.spender);
  const ai = fieldIndex(d, d.roles.amount);
  const di = fieldIndex(d, d.roles.deadline);
  if (si < 0) throw new DescriptorError(d.key, 'unknown_role_field', `spender role field "${d.roles.spender}" absent`);
  if (ai < 0) throw new DescriptorError(d.key, 'unknown_role_field', `amount role field "${d.roles.amount}" absent`);
  if (di < 0) throw new DescriptorError(d.key, 'unknown_role_field', `deadline role field "${d.roles.deadline}" absent`);
  const spenderType = d.fields[si]?.type;
  const amountType = d.fields[ai]?.type;
  const deadlineType = d.fields[di]?.type;
  if (spenderType !== 'address') {
    throw new DescriptorError(d.key, 'role_type_mismatch', `spender role field must be address`);
  }
  if (!amountType || !/^uint\d+$/.test(amountType)) {
    throw new DescriptorError(d.key, 'role_type_mismatch', `amount role field must be uintN`);
  }
  if (!deadlineType || !/^uint\d+$/.test(deadlineType)) {
    throw new DescriptorError(d.key, 'role_type_mismatch', `deadline role field must be uintN`);
  }
  // Role indices pairwise distinct — mirror the on-chain index-aliasing guard
  // (`proposeSigningGrant` reverts InvalidPolicy): a single word read as two roles
  // (a deadline decoded as the amount) would mis-bound the signature.
  if (si === ai || si === di || ai === di) {
    throw new DescriptorError(d.key, 'role_index_alias', 'spender/amount/deadline must map to distinct fields');
  }
}

function fieldIndex(d: SigningDescriptor, name: string): number {
  return d.fields.findIndex((f) => f.name === name);
}

/**
 * The EIP-712 `encodeType` string for a descriptor's flat struct. N-02 guarantees
 * no referenced sub-types, so this is the complete canonical type string.
 */
export function encodeType(primaryType: string, fields: readonly Eip712Field[]): string {
  return `${primaryType}(${fields.map((f) => `${f.type} ${f.name}`).join(',')})`;
}

/** `typeHash = keccak256(encodeType)` — the value the on-chain policy stores. */
export function descriptorTypeHash(d: SigningDescriptor): Hex {
  return keccak256(toBytes(encodeType(d.primaryType, d.fields)));
}

/**
 * `domainSeparator = keccak256(abi.encode(domainTypeHash, …present-field words))`.
 * Computed with the raw EIP-712 formula (the same one the contract would use)
 * rather than viem's generic typed-data API, so it typechecks against runtime
 * descriptor data AND is provably identical to the on-chain stored separator.
 * `getTypesForEIP712Domain` gives the present fields in canonical EIP-712 order.
 */
export function descriptorDomainSeparator(d: SigningDescriptor): Hex {
  const present = getTypesForEIP712Domain({ domain: toViemDomain(d.domain) });
  const typeString = `EIP712Domain(${present.map((p) => `${p.type} ${p.name}`).join(',')})`;
  const domainTypeHash = keccak256(toBytes(typeString));
  const words: Hex[] = [domainTypeHash];
  for (const p of present) {
    if (p.type === 'string') {
      // name / version are hashed (dynamic → hash-of-bytes per EIP-712).
      const v = p.name === 'name' ? (d.domain.name ?? '') : (d.domain.version ?? '');
      words.push(keccak256(toBytes(v)));
    } else if (p.type === 'uint256') {
      words.push(encodeAbiParameters([{ type: 'uint256' }], [BigInt(d.domain.chainId)]));
    } else if (p.type === 'address') {
      words.push(encodeAbiParameters([{ type: 'address' }], [d.domain.verifyingContract.toLowerCase() as Hex]));
    } else if (p.type === 'bytes32') {
      words.push(encodeAbiParameters([{ type: 'bytes32' }], [d.domain.salt ?? ZERO_WORD]));
    }
  }
  return keccak256(concat(words));
}

const ZERO_WORD: Hex = '0x0000000000000000000000000000000000000000000000000000000000000000';

/** The descriptor's EIP-712 domain, lowercased (shared with the builder). */
export function toViemDomain(domain: Eip712Domain): {
  name?: string;
  version?: string;
  chainId: number;
  verifyingContract: Hex;
  salt?: Hex;
} {
  return {
    ...(domain.name !== undefined ? { name: domain.name } : {}),
    ...(domain.version !== undefined ? { version: domain.version } : {}),
    chainId: domain.chainId,
    verifyingContract: domain.verifyingContract.toLowerCase() as Hex,
    ...(domain.salt !== undefined ? { salt: domain.salt } : {}),
  };
}

/**
 * The on-chain grant parameters the owner's `proposeSigningGrant` must store for a
 * descriptor — computed here so the wall's stored `domainSeparator`/`typeHash` and
 * the engine's reconstruction are byte-identical (FP-e: adding a protocol is a
 * grant, never a code change). The owner's client signs the tx with exactly these.
 */
export interface OnChainGrantParams {
  descriptorId: number;
  domainSeparator: Hex;
  typeHash: Hex;
  numFields: number;
  spenderIndex: number;
  amountIndex: number;
  deadlineIndex: number;
}

export function onChainGrantParams(d: SigningDescriptor): OnChainGrantParams {
  return {
    descriptorId: d.descriptorId,
    domainSeparator: descriptorDomainSeparator(d),
    typeHash: descriptorTypeHash(d),
    numFields: d.fields.length,
    spenderIndex: fieldIndex(d, d.roles.spender),
    amountIndex: fieldIndex(d, d.roles.amount),
    deadlineIndex: fieldIndex(d, d.roles.deadline),
  };
}

export interface SigningRegistry {
  get(descriptorId: number): SigningDescriptor | undefined;
  byKey(key: string): SigningDescriptor | undefined;
  list(): SigningDescriptor[];
}

/**
 * Build a registry from a descriptor set. EVERY descriptor is asserted (N-01/N-02)
 * at construction — a defective descriptor throws here, so a bad descriptor can
 * never silently enter the engine.
 */
export function createSigningRegistry(descriptors: readonly SigningDescriptor[] = BUILT_IN): SigningRegistry {
  const byId = new Map<number, SigningDescriptor>();
  const byKey = new Map<string, SigningDescriptor>();
  for (const d of descriptors) {
    assertDescriptor(d);
    if (byId.has(d.descriptorId)) throw new Error(`duplicate descriptorId ${d.descriptorId}`);
    byId.set(d.descriptorId, d);
    byKey.set(d.key, d);
  }
  return {
    get: (descriptorId) => byId.get(descriptorId),
    byKey: (key) => byKey.get(key),
    list: () => [...byId.values()],
  };
}

/**
 * The v1 built-in descriptor set (FP-2). A deliberately SMALL, canonical seed — the
 * BROAD protocol seeding (Permit2 nested-struct flattening, CoW, Hyperliquid) is
 * FP-3. `verifyingContract` here is a per-chain placeholder; FP-3 wires the real
 * deployed addresses per chain. ERC-2612 is the canonical flat permit.
 */
export const BUILT_IN: readonly SigningDescriptor[] = [
  {
    descriptorId: 1,
    key: 'erc2612.permit',
    label: 'ERC-2612 token permit',
    protocol: 'ERC-2612 Permit',
    domain: {
      name: 'LeashSeedToken',
      version: '1',
      chainId: 16601,
      verifyingContract: '0x0000000000000000000000000000000000000a11',
    },
    primaryType: 'Permit',
    // EIP-2612 Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)
    fields: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
    roles: { spender: 'spender', amount: 'value', deadline: 'deadline' },
    sensitive: false,
  },
];

export const defaultSigningRegistry: SigningRegistry = createSigningRegistry();
