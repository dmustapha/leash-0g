/**
 * Governed signing engine (Stage F′, FP-2) — the off-chain descriptor-driven
 * engine that drives the `LeashAccountV5` signing spine. Public surface.
 */
export type {
  Eip712Domain,
  Eip712Field,
  Eip712NestedGroup,
  SigningDescriptor,
  SigningRule,
  SigningGrantState,
  SigningClassification,
  SigningTrigger,
  SigningWidenReason,
  SigningForbiddenReason,
} from './types.js';
export {
  createSigningRegistry,
  defaultSigningRegistry,
  assertDescriptor,
  DescriptorError,
  descriptorTypeHash,
  descriptorDomainSeparator,
  descriptorLeaves,
  foldSpec,
  onChainGrantParams,
  encodeType,
  tokenCapsHash,
  TOKEN_PERMISSIONS_TYPE_STRING,
  PBTF_TYPE_STRING,
  BUILT_IN as BUILT_IN_DESCRIPTORS,
  type SigningRegistry,
  type OnChainGrantParams,
  type FoldSpec,
} from './intent-registry.js';
export { classifySigning, type IntendedSigning } from './intent-classify.js';
export {
  buildIntent,
  buildBatchIntent,
  decodeForHuman,
  type BuildIntentInput,
  type BuildIntentResult,
  type BuildBatchIntentInput,
  type BuildBatchIntentResult,
} from './intent-builder.js';
export { permit2BatchDescriptor, PERMIT2_ADDRESS } from './descriptors.js';
export { computeSigningRequestHash } from './intent-hash.js';
