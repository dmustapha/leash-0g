import type { Json } from '../../crypto/canonical.js';
import {
  classifyTool,
  guardToolArgs,
  type ToolClassification,
  type ToolDescriptor,
  type ToolGrantState,
  type ToolRegistry,
} from '../../tool-use/index.js';

/**
 * The governed tool-use gate (SF-3) — the OFF-CHAIN interception point the MCP
 * transport + the runtime consult BEFORE a tool call egresses, mirror of
 * `gateway/call-gate.ts`. It ONLY narrows: the gateway egress proxy is the sole
 * boundary (there is no on-chain backstop for an off-chain tool call, §8), so the
 * gate is fail-closed at every step:
 *
 *   1. I/O-guard the model-supplied `arguments` FIRST (size/depth/proto-pollution/
 *      bidi/type-smuggle, C-SF1-1/C-SF1-4). A rejection is `forbidden:io_rejected`
 *      — a poisoned arg bag never reaches classify, the model, or egress.
 *   2. Resolve the descriptor from the registry (unknown tool → forbidden).
 *   3. Classify against grant-state ONLY (never the result, never model text):
 *      L1 forward / L2 raise-JIT / forbidden refuse.
 *   4. Resolve the allowlisted egress endpoint (only when not forbidden) so the
 *      proxy forwards to an owner-configured origin, never a model-supplied URL.
 */

export interface ToolGateResult {
  toolId: string;
  descriptor: ToolDescriptor | undefined;
  /** the sanitized args (the exact bytes that would egress); `{}` when io-rejected. */
  guardedArgs: Record<string, Json>;
  classification: ToolClassification;
  /** the resolved allowlisted external MCP endpoint — present iff classification is not forbidden. */
  endpoint: string | undefined;
}

export function gateToolCall(
  toolId: string,
  rawArgs: unknown,
  registry: ToolRegistry,
  grant: ToolGrantState,
  maxIoBytes?: number,
): ToolGateResult {
  const id = toolId.toLowerCase();

  // (1) I/O guard FIRST — a hostile arg bag is refused before anything else.
  const guarded = guardToolArgs(rawArgs, maxIoBytes);
  if (!guarded.ok) {
    return {
      toolId: id,
      descriptor: registry.get(id),
      guardedArgs: {},
      classification: { lane: 'forbidden', reason: 'io_rejected' },
      endpoint: undefined,
    };
  }

  // (2)+(3) descriptor + three-lane classify (grant-state only).
  const descriptor = registry.get(id);
  const classification = classifyTool({ toolId: id, args: guarded.value }, descriptor, grant);

  // (4) resolve the owner-configured egress endpoint for a non-forbidden call.
  const endpoint =
    classification.lane !== 'forbidden' && descriptor
      ? grant.serverEndpoints.get(descriptor.server)
      : undefined;

  return { toolId: id, descriptor, guardedArgs: guarded.value, classification, endpoint };
}
