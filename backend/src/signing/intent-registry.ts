import { keccak256, toBytes, concat, encodeAbiParameters, getTypesForEIP712Domain, type Hex } from 'viem';
import type { Eip712Domain, Eip712Field, SigningDescriptor } from './types.js';
import { FP3_DESCRIPTORS } from './descriptors.js';

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
      | 'role_index_alias'
      | 'order_layout'
      | 'missing_constant_pin'
      | 'batch_layout'
      | 'bad_token_cap',
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
/**
 * FP-4 Slice-4 (§3a/§5.2) — the N-02 override gate. A field whose `.type` is NOT a static word is
 * accepted ONLY as a gated pre-hashed CONSTANT leaf: `descriptor.kind === 'order'` AND
 * `field.preHashedConstant === true` AND a FIXED `constantPins[name]` is present. `isStaticWordType`
 * stays strict (`isStaticWordType('string') === false`), so any ungated/free/dynamic string — including a
 * `string` without the flag/pin, or a `preHashedConstant` outside an `order` — still fails `dynamic_field`.
 * The submitted leaf remains a single pinned static word (N-02 preserved as a LEAF invariant).
 */
function isGatedPreHashedConstant(d: SigningDescriptor, f: Eip712Field): boolean {
  return d.kind === 'order' && f.preHashedConstant === true && d.constantPins?.[f.name] !== undefined;
}

/** FP-4 Slice-5 — the canonical Permit2 `PermitBatchTransferFrom` + `TokenPermissions` type strings; the
 *  computed `descriptorTypeHash` of a batch descriptor is asserted == `keccak256(PBTF_TYPE_STRING)` in the
 *  engine test (a genuine, non-circular oracle vs Permit2's published constant). */
export const TOKEN_PERMISSIONS_TYPE_STRING = 'TokenPermissions(address token,uint256 amount)';
export const PBTF_TYPE_STRING =
  'PermitBatchTransferFrom(TokenPermissions[] permitted,address spender,uint256 nonce,uint256 deadline)' +
  TOKEN_PERMISSIONS_TYPE_STRING;

/**
 * FP-4 Slice-5 — validate a batch descriptor's reviewed per-token cap allowlist (N-01 mirror of the on-chain
 * `validateBatchCaps`): present, non-empty, each a valid lowercased 0x token, each cap a positive base-units
 * integer, NO duplicate token. A mis-authored allowlist is a LOUD reviewer error PRE-GRANT (never silent).
 */
function assertTokenCaps(d: SigningDescriptor): void {
  const caps = d.tokenCaps;
  if (!caps || caps.length === 0) throw new DescriptorError(d.key, 'bad_token_cap', 'batch requires a non-empty tokenCaps allowlist');
  const seen = new Set<string>();
  for (const c of caps) {
    const t = c.token.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(t) || t === ZERO_ADDR) throw new DescriptorError(d.key, 'bad_token_cap', `tokenCaps token "${c.token}" is not a nonzero 0x address`);
    if (!/^\d{1,40}$/.test(c.cap) || BigInt(c.cap) <= 0n) throw new DescriptorError(d.key, 'bad_token_cap', `tokenCaps cap for "${c.token}" must be a positive base-units integer`);
    if (seen.has(t)) throw new DescriptorError(d.key, 'bad_token_cap', `duplicate token "${c.token}" in tokenCaps`);
    seen.add(t);
  }
}

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
  if (d.fields.length === 0) throw new DescriptorError(d.key, 'no_fields', 'descriptor has no top-level fields');

  // FP-3 (R-6/S3): N-02 recurses into the single nested group — every LEAF (the nested member's
  // subFields + every other top member) must be a static 32-byte word; the nested member itself is
  // the sub-struct (its `type` names the sub-struct, validated via subFields, never a leaf).
  if (d.nested) {
    const nested = d.nested;
    const topPos = d.fields.findIndex((f) => f.name === nested.memberName);
    if (topPos < 0) {
      throw new DescriptorError(d.key, 'unknown_role_field', `nested member "${nested.memberName}" absent from fields`);
    }
    if (nested.subFields.length === 0) {
      throw new DescriptorError(d.key, 'no_fields', 'nested group has no subFields');
    }
    for (const sub of nested.subFields) {
      if (!isStaticWordType(sub.type)) {
        throw new DescriptorError(d.key, 'dynamic_field', `nested leaf "${sub.name}" type "${sub.type}" is not a static 32-byte word (N-02)`);
      }
    }
    for (const f of d.fields) {
      if (f.name === nested.memberName) continue; // the sub-struct member, validated above
      if (!isStaticWordType(f.type) && !isGatedPreHashedConstant(d, f)) {
        throw new DescriptorError(d.key, 'dynamic_field', `field "${f.name}" type "${f.type}" is not a static 32-byte word (N-02)`);
      }
    }
  } else {
    for (const f of d.fields) {
      if (!isStaticWordType(f.type) && !isGatedPreHashedConstant(d, f)) {
        throw new DescriptorError(d.key, 'dynamic_field', `field "${f.name}" type "${f.type}" is not a static 32-byte word (N-02)`);
      }
    }
  }

  // FP-4 Slice-5 — Permit2 `PermitBatchTransferFrom` (the first `kind: 'batch'`): the nested member is an
  // ARRAY of `TokenPermissions`, so the leaf count is runtime-variable (N elements) — the fixed-leaf
  // helpers (`descriptorLeaves`/`foldSpec`) CANNOT expand it and must not run. Validate the batch shape here
  // and RETURN (N-02 stays intact — every element leaf is a static word; no `preHashedConstant`, which is
  // order-only). The caps allowlist is the off-chain mirror of the on-chain committed `TokenCap[]`.
  if (d.kind === 'batch') {
    const g = d.nested;
    if (!g || g.array !== true) throw new DescriptorError(d.key, 'batch_layout', 'batch requires a nested array group (nested.array === true)');
    if (g.structType !== 'TokenPermissions') throw new DescriptorError(d.key, 'batch_layout', 'batch nested structType must be TokenPermissions');
    if (g.subFields.length !== 2 || g.subFields[0]?.name !== 'token' || g.subFields[0]?.type !== 'address' || g.subFields[1]?.name !== 'amount' || g.subFields[1]?.type !== 'uint256') {
      throw new DescriptorError(d.key, 'batch_layout', 'batch TokenPermissions must be [token:address, amount:uint256]');
    }
    // Top members: [permitted (the array), spender:address, nonce:uint256, deadline:uint256] (EIP-712 order).
    const names = d.fields.map((f) => f.name);
    if (d.fields.length !== 4 || names[0] !== g.memberName || names[1] !== 'spender' || names[2] !== 'nonce' || names[3] !== 'deadline') {
      throw new DescriptorError(d.key, 'batch_layout', 'batch top fields must be [permitted[], spender, nonce, deadline]');
    }
    if (d.fields[1]?.type !== 'address' || d.fields[2]?.type !== 'uint256' || d.fields[3]?.type !== 'uint256') {
      throw new DescriptorError(d.key, 'batch_layout', 'batch spender must be address, nonce/deadline uint256');
    }
    if (d.fields.some((f) => f.preHashedConstant)) throw new DescriptorError(d.key, 'batch_layout', 'batch has no preHashedConstant leaves (order-only)');
    // Roles: spender/deadline resolve to the top members; batchRoles name the element fields (token, amount).
    if (d.roles.spender !== 'spender') throw new DescriptorError(d.key, 'batch_layout', 'batch roles.spender must be "spender"');
    if (d.roles.deadline !== 'deadline') throw new DescriptorError(d.key, 'batch_layout', 'batch roles.deadline must be "deadline"');
    if (d.batchRoles?.token !== 'token' || d.batchRoles?.amount !== 'amount') {
      throw new DescriptorError(d.key, 'batch_layout', 'batch batchRoles must name the TokenPermissions fields {token, amount}');
    }
    assertTokenCaps(d);
    return; // batch is fully validated; the fixed-leaf checks below do NOT apply
  }

  // Bounds mirror the on-chain `_stageSigningGrant` (1..32 LEAVES).
  const leaves = descriptorLeaves(d);
  if (leaves.length > 32) throw new DescriptorError(d.key, 'too_many_fields', 'descriptor exceeds 32 leaves');

  // Role fields resolve to LEAF indices + carry the right static type. An ORDER has NO spender (I-1 —
  // `roles.spender` is optional); its spender-present/type/distinctness checks are skipped. Flat/nested
  // always set `roles.spender`, so their behavior is unchanged (R-6).
  const ai = leaves.findIndex((f) => f.name === d.roles.amount);
  const di = leaves.findIndex((f) => f.name === d.roles.deadline);
  if (ai < 0) throw new DescriptorError(d.key, 'unknown_role_field', `amount role leaf "${d.roles.amount}" absent`);
  if (di < 0) throw new DescriptorError(d.key, 'unknown_role_field', `deadline role leaf "${d.roles.deadline}" absent`);
  if (!/^uint\d+$/.test(leaves[ai]?.type ?? '')) {
    throw new DescriptorError(d.key, 'role_type_mismatch', `amount role leaf must be uintN`);
  }
  if (!/^uint\d+$/.test(leaves[di]?.type ?? '')) {
    throw new DescriptorError(d.key, 'role_type_mismatch', `deadline role leaf must be uintN`);
  }
  if (ai === di) {
    throw new DescriptorError(d.key, 'role_index_alias', 'amount/deadline must map to distinct leaves');
  }
  let si = -1;
  if (d.roles.spender !== undefined) {
    si = leaves.findIndex((f) => f.name === d.roles.spender);
    if (si < 0) throw new DescriptorError(d.key, 'unknown_role_field', `spender role leaf "${d.roles.spender}" absent`);
    if (leaves[si]?.type !== 'address') {
      throw new DescriptorError(d.key, 'role_type_mismatch', `spender role leaf must be address`);
    }
    if (si === ai || si === di) {
      throw new DescriptorError(d.key, 'role_index_alias', 'spender/amount/deadline must map to distinct leaves');
    }
  }

  // FP-4 Slice-4 (§5.2) — the ORDER layout branch (fail-closed; N-01 unchanged). The on-chain GPv2Order
  // layout is FIXED, so beyond the generic role checks the descriptor must prove the canonical shape:
  // 12 leaves, no nesting, NO spender role, sellAmount=3/validTo=5, the three `orderRoles` at their fixed
  // positions, and every reviewed `constantPins` present (the wall + builder both pin these).
  if (d.kind === 'order') {
    if (d.nested) throw new DescriptorError(d.key, 'order_layout', 'order descriptor must not be nested');
    if (leaves.length !== 12) throw new DescriptorError(d.key, 'order_layout', 'order must have exactly 12 GPv2Order leaves');
    if (d.roles.spender !== undefined) throw new DescriptorError(d.key, 'order_layout', 'order has no spender role (I-1)');
    if (ai !== 3) throw new DescriptorError(d.key, 'order_layout', 'order sellAmount must be leaf 3');
    if (di !== 5) throw new DescriptorError(d.key, 'order_layout', 'order validTo must be leaf 5');
    const or = d.orderRoles;
    if (!or) throw new DescriptorError(d.key, 'order_layout', 'order requires orderRoles');
    const assertLeaf = (name: string, pos: number, kind: 'address' | 'uint'): void => {
      const idx = leaves.findIndex((f) => f.name === name);
      if (idx !== pos) throw new DescriptorError(d.key, 'order_layout', `order leaf "${name}" must be at position ${pos}`);
      const t = leaves[idx]?.type ?? '';
      const ok = kind === 'address' ? t === 'address' : /^uint\d+$/.test(t);
      if (!ok) throw new DescriptorError(d.key, 'role_type_mismatch', `order leaf "${name}" must be ${kind}`);
    };
    assertLeaf(or.sellToken, 0, 'address');
    assertLeaf(or.receiver, 2, 'address');
    assertLeaf(or.fee, 7, 'uint');
    // `receiver` is NOT a constantPin — it is self-pinned via `isOwnerField` (confused-deputy-safe); the wall
    // also hard-pins it to the account. Every OTHER order leaf is a reviewed FIXED constant.
    for (const name of ['sellToken', 'buyToken', 'feeAmount', 'appData', 'kind', 'partiallyFillable', 'sellTokenBalance', 'buyTokenBalance']) {
      if (d.constantPins?.[name] === undefined) {
        throw new DescriptorError(d.key, 'missing_constant_pin', `order constantPins["${name}"] is required`);
      }
    }
  }
  // FP-3 (R-2): the optional secondary-expiry leaf must exist, be uintN, and be distinct from roles.
  if (d.expiryRole !== undefined) {
    const ei = leaves.findIndex((f) => f.name === d.expiryRole);
    if (ei < 0) throw new DescriptorError(d.key, 'unknown_role_field', `expiry role leaf "${d.expiryRole}" absent`);
    if (!/^uint\d+$/.test(leaves[ei]?.type ?? '')) {
      throw new DescriptorError(d.key, 'role_type_mismatch', `expiry role leaf must be uintN`);
    }
    if (ei === si || ei === ai || ei === di) {
      throw new DescriptorError(d.key, 'role_index_alias', 'expiry must map to a leaf distinct from the roles');
    }
  }
}

/** Index of a role in the flat LEAF list (the index the on-chain policy stores). */
function leafIndex(d: SigningDescriptor, name: string): number {
  return descriptorLeaves(d).findIndex((f) => f.name === name);
}

/**
 * The EIP-712 `encodeType` fragment for ONE struct: `Primary(type name,type name,…)`. For a nested
 * descriptor the top-level fragment renders the nested member as `SubType memberName`.
 */
export function encodeType(primaryType: string, fields: readonly Eip712Field[]): string {
  return `${primaryType}(${fields.map((f) => `${f.type} ${f.name}`).join(',')})`;
}

/**
 * FP-3: the flat LEAF fields of a descriptor in EIP-712 pre-order. FLAT ⇒ `fields` verbatim (FP-1).
 * NESTED ⇒ the one nested member is expanded in place to its `subFields` (every other member is a
 * single leaf), so the leaf list is exactly what the session key submits + what the wall indexes.
 */
export function descriptorLeaves(d: SigningDescriptor): Eip712Field[] {
  // FP-4 Slice-5 — a batch descriptor's leaf list is runtime-variable (N array elements); the fixed-leaf
  // expansion is meaningless for it. Fail LOUD rather than silently mis-expand (the batch build/validate
  // path never routes through here).
  if (d.kind === 'batch' || d.nested?.array) {
    throw new DescriptorError(d.key, 'batch_layout', 'descriptorLeaves is not defined for a batch (array) descriptor');
  }
  if (!d.nested) return [...d.fields];
  const out: Eip712Field[] = [];
  for (const f of d.fields) {
    if (f.name === d.nested.memberName) out.push(...d.nested.subFields);
    else out.push(f);
  }
  return out;
}

/** The on-chain fold spec (leaf-space) a descriptor maps to — mirror of the pending-grant fields. */
export interface FoldSpec {
  numTopFields: number;
  nestedTypeHash: Hex; // ZERO_WORD when flat
  nestedLeafStart: number; // 0 when flat
  nestedLeafCount: number; // 0 when flat
}

export function foldSpec(d: SigningDescriptor): FoldSpec {
  if (d.kind === 'batch' || d.nested?.array) {
    throw new DescriptorError(d.key, 'batch_layout', 'foldSpec is not defined for a batch (array) descriptor');
  }
  if (!d.nested) {
    return { numTopFields: d.fields.length, nestedTypeHash: ZERO_WORD, nestedLeafStart: 0, nestedLeafCount: 0 };
  }
  // The nested member's TOP position == the number of leaves before it (all prior top members are
  // single leaves, since there is exactly one nested group) — so it also equals nestedLeafStart.
  const nested = d.nested;
  const topPos = d.fields.findIndex((f) => f.name === nested.memberName);
  if (topPos < 0) {
    throw new DescriptorError(d.key, 'unknown_role_field', `nested member "${nested.memberName}" absent from fields`);
  }
  return {
    numTopFields: d.fields.length,
    nestedTypeHash: keccak256(toBytes(encodeType(nested.structType, nested.subFields))),
    nestedLeafStart: topPos,
    nestedLeafCount: nested.subFields.length,
  };
}

/** `typeHash = keccak256(encodeType)` — the value the on-chain policy stores (VERBATIM). For a nested
 * descriptor the referenced sub-type string is appended (one sub-type ⇒ trivial alphabetical order),
 * reproducing the PROTOCOL's real combined type string (FP-3 review R-6). */
export function descriptorTypeHash(d: SigningDescriptor): Hex {
  const primary = encodeType(d.primaryType, d.fields);
  if (!d.nested) return keccak256(toBytes(primary));
  const sub = encodeType(d.nested.structType, d.nested.subFields);
  return keccak256(toBytes(primary + sub));
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
  /** TOP-LEVEL member count (the on-chain `numFields`). */
  numFields: number;
  /** LEAF-space role indices (what the wall reads from the submitted leaf array). */
  spenderIndex: number;
  amountIndex: number;
  deadlineIndex: number;
  /** FP-3: the on-chain fold spec (0 / ZERO_WORD when flat). */
  nestedTypeHash: Hex;
  nestedLeafStart: number;
  nestedLeafCount: number;
  /** FP-3 (R-2): secondary-expiry leaf index, or 255 (0xFF) sentinel when none. */
  expiryLeafIndex: number;
  /** FP-4 Slice-4 (§4.1): the on-chain `kind` discriminant — 0 (flat|nested) / 1 (order). */
  kind: number;
  /** FP-4 Slice-4 (G11(b)): the wall-pinned per-pair proceeds token for order; ZERO_ADDR otherwise. */
  buyToken: Hex;
  /** FP-4 Slice-5 (caps-hash commit): the reviewed per-token cap allowlist the owner submits to
   *  `proposeSigningGrantNested` (on-chain shape); empty for non-batch. */
  tokenCaps: { token: Hex; cap: string }[];
  /** FP-4 Slice-5: `keccak256(abi.encode(TokenCap[]))` — the commitment the wall stores + the arm re-derives.
   *  ZERO_WORD for non-batch. Mirrors the on-chain `validateBatchCaps` return exactly. */
  tokenCapsHash: Hex;
}

const NO_EXPIRY_LEAF = 255; // 0xFF sentinel — mirrors the on-chain `type(uint8).max`.
const NO_SPENDER_LEAF = 255; // 0xFF — a CoW order has no spender leaf (I-1).

export function onChainGrantParams(d: SigningDescriptor): OnChainGrantParams {
  // FP-4 Slice-5 — batch (caps-hash commit): the fixed-leaf `foldSpec` throws for an array descriptor, so
  // build the grant params directly. All four scalar indices are the 0xFF sentinel (the wall derives
  // positions from N); the fold spec names `TokenPermissions` (nestedLeafCount=2, start=0); `typeHash` is
  // the genuine `PBTF_TYPEHASH` (reproduced by `descriptorTypeHash`); the owner submits `tokenCaps` and the
  // wall stores only `tokenCapsHash = keccak256(abi.encode(caps))`.
  if (d.kind === 'batch') {
    const caps = (d.tokenCaps ?? []).map((c) => ({ token: c.token.toLowerCase() as Hex, cap: c.cap }));
    return {
      descriptorId: d.descriptorId,
      domainSeparator: descriptorDomainSeparator(d),
      typeHash: descriptorTypeHash(d),
      numFields: 4,
      spenderIndex: NO_SPENDER_LEAF,
      amountIndex: NO_EXPIRY_LEAF, // 0xFF — unused for batch
      deadlineIndex: NO_EXPIRY_LEAF, // 0xFF — unused for batch
      nestedTypeHash: keccak256(toBytes(encodeType('TokenPermissions', d.nested?.subFields ?? []))),
      nestedLeafStart: 0,
      nestedLeafCount: 2,
      expiryLeafIndex: NO_EXPIRY_LEAF,
      kind: 2,
      buyToken: ZERO_ADDR_HEX,
      tokenCaps: caps,
      tokenCapsHash: tokenCapsHash(caps),
    };
  }
  const fold = foldSpec(d);
  const isOrder = d.kind === 'order';
  return {
    descriptorId: d.descriptorId,
    domainSeparator: descriptorDomainSeparator(d),
    typeHash: descriptorTypeHash(d),
    numFields: fold.numTopFields,
    // I-1: order carries `spenderIndex = 0xFF` (no spender leaf); flat/nested resolve the spender role.
    spenderIndex: isOrder || d.roles.spender === undefined ? NO_SPENDER_LEAF : leafIndex(d, d.roles.spender),
    amountIndex: leafIndex(d, d.roles.amount),
    deadlineIndex: leafIndex(d, d.roles.deadline),
    nestedTypeHash: fold.nestedTypeHash,
    nestedLeafStart: fold.nestedLeafStart,
    nestedLeafCount: fold.nestedLeafCount,
    expiryLeafIndex: d.expiryRole !== undefined ? leafIndex(d, d.expiryRole) : NO_EXPIRY_LEAF,
    kind: isOrder ? 1 : 0,
    // G11(b): the reviewed per-pair proceeds token the wall pins `fields[1]` to; ZERO_ADDR for non-order.
    buyToken: isOrder ? (coercePinAddress(d.constantPins?.['buyToken']) ?? ZERO_ADDR_HEX) : ZERO_ADDR_HEX,
    tokenCaps: [],
    tokenCapsHash: ZERO_WORD,
  };
}

/** FP-4 Slice-5 — `keccak256(abi.encode(TokenCap[]))`, the caps commitment the on-chain `validateBatchCaps`
 *  returns byte-for-byte (TokenCap = `(address token, uint128 cap)`). The owner submits the caps array; the
 *  wall stores only this hash; the arm re-derives + compares (caps-hash commit, Dami 2026-10-08). */
export function tokenCapsHash(caps: { token: Hex; cap: string }[]): Hex {
  // Positional tuple values (unnamed components) — mirrors Solidity `abi.encode(TokenCap[])` where TokenCap
  // is `(address token, uint128 cap)`, so this hash equals the on-chain `validateBatchCaps` return byte-for-byte.
  const encoded = encodeAbiParameters(
    [{ type: 'tuple[]', components: [{ type: 'address' }, { type: 'uint128' }] }],
    [caps.map((c) => [c.token.toLowerCase() as Hex, BigInt(c.cap)]) as never],
  );
  return keccak256(encoded);
}

const ZERO_ADDR_HEX: Hex = '0x0000000000000000000000000000000000000000';

/** Lowercased 0x address from a constant pin, or null if absent/malformed (fail-closed at the grant edge). */
function coercePinAddress(v: string | bigint | boolean | undefined): Hex | null {
  if (typeof v !== 'string') return null;
  const s = v.toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(s) ? (s as Hex) : null;
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
 * The built-in descriptor set. Descriptor 1 is the FP-2 canonical ERC-2612 seed (a per-chain
 * placeholder verifyingContract; kept stable — FP-2 tests + the read-model reference it). FP-3
 * APPENDS the REAL per-chain descriptors (`FP3_DESCRIPTORS`): real Circle USDC ERC-2612 (flat,
 * Base/Arb/Eth) + Permit2 `PermitSingle` (one-level nested, all 4 chains). Each is asserted
 * (N-01/N-02) at construction; adding a protocol is a descriptor + grant, never a code change (FP-e).
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
  ...FP3_DESCRIPTORS,
];

export const defaultSigningRegistry: SigningRegistry = createSigningRegistry();
