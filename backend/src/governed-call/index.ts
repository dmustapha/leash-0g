/**
 * Governed-calldata grammar (Stage D) — the OFF-CHAIN layer that narrows the
 * on-chain `LeashAccountV4` wall. Public surface:
 *  - decodeCall: strict-canonical decode → legible intent + authority args (H-04).
 *  - classify: three-lane novelty routing against the on-chain envelope mirror.
 *  - expandPreset / presets: the broad-grant UX (D-9) + the global JIT deny-list.
 */
export * from './types.js';
export { decodeCall } from './decoder.js';
export { classify, ruleKey } from './classify.js';
export { computeCallHash } from './call-hash.js';
export { buildGovernedCall, type GovernedCallIntent, type BuildGovernedCallResult, type TradeFill } from './call-builder.js';
export {
  expandPreset,
  getPresetDef,
  presetKeys,
  GLOBAL_DENY_LIST,
  type TargetCatalog,
  type TargetKey,
} from './presets.js';
export { SELECTORS, WRAPPER_SELECTORS, SELF_EDIT_SELECTORS, BRIDGE_SELECTORS } from './selectors.js';
export {
  buildGasSwapCalls,
  buildWrappedNativeUnwrap,
  GAS_SWAP_AMOUNT_OUT_MINIMUM,
  type GasSwapCall,
  type GasSwapParams,
} from './gas-swap.js';
