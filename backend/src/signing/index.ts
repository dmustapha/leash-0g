/**
 * Governed signing engine (Stage F′, FP-2) — the off-chain descriptor-driven
 * engine that drives the `LeashAccountV5` signing spine. Public surface.
 */
export type {
  Eip712Domain,
  Eip712Field,
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
  onChainGrantParams,
  encodeType,
  BUILT_IN as BUILT_IN_DESCRIPTORS,
  type SigningRegistry,
  type OnChainGrantParams,
} from './intent-registry.js';
export { classifySigning, type IntendedSigning } from './intent-classify.js';
export { buildIntent, decodeForHuman, type BuildIntentInput, type BuildIntentResult } from './intent-builder.js';
export { computeSigningRequestHash } from './intent-hash.js';
