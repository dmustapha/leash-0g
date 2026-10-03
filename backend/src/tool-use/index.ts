/**
 * Governed tool-use grammar (Stage F, SF-3) — the OFF-CHAIN tool-governance layer
 * that mirrors `governed-call/`. Public surface:
 *  - classifyTool: three-lane L1/L2/forbidden routing from GRANT-STATE ONLY.
 *  - tool-registry: canonical descriptors + per-tool authority-arg roles + GLOBAL_DENY.
 *  - tool-presets: the broad-grant UX (curated bundles) under default-deny.
 *  - tool-io-guard: bound+sanitize args AND results (size/depth/proto-pollution/bidi/type).
 */
export * from './types.js';
export { classifyTool, originOf, resolveEgressEndpoint, type IntendedToolCall } from './tool-classify.js';
export {
  createToolRegistry,
  defaultToolRegistry,
  GLOBAL_DENY_TOOLS,
  type ToolRegistry,
} from './tool-registry.js';
export {
  expandToolPreset,
  toolPresetKeys,
  type ToolPresetKey,
  type ResolvedToolPreset,
} from './tool-presets.js';
export { computeToolCallHash } from './tool-hash.js';
export {
  guardToolArgs,
  guardToolResult,
  DEFAULT_MAX_IO_BYTES,
  MAX_IO_DEPTH,
  type GuardResult,
} from './tool-io-guard.js';
