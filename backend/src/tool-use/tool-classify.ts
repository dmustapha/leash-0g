import type { Json } from '../crypto/canonical.js';
import type { ToolClassification, ToolDescriptor, ToolGrantState, ToolTrigger } from './types.js';

/**
 * The intended tool call the classifier routes. `args` are ALREADY guarded
 * (tool-io-guard.ts) — classify inspects only AUTHORITY args structurally
 * (recipient values, serialized size), never as instructions, exactly as the
 * on-chain `classify` reads `decoded.args` and never model text.
 */
export interface IntendedToolCall {
  toolId: string;
  args: Record<string, Json>;
}

/**
 * Classify an intended tool call against the owner's tool grant-state (SF-3, the
 * three-lane model — mirror of `governed-call/classify.ts`). PURE: reads only the
 * passed descriptor (registry) + grant-state mirror. It NEVER reads a tool RESULT
 * or model text, so a tool's output can never widen what another tool may do
 * (§8 tool-chaining escalation, F-3c). Fail-closed by construction:
 *   - unknown tool                → forbidden (default-deny, never guessed);
 *   - no allowing rule            → forbidden (default-deny, `07 S28`);
 *   - no allowlisted egress       → forbidden (SSRF/egress guard, §8);
 *   - sensitive                   → L2 ALWAYS (00 §6c — reasoning never trusted);
 *   - authority arg outside policy→ L2 (owner must consent);
 *   - otherwise                   → L1 (execute silently).
 */
export function classifyTool(
  intended: IntendedToolCall,
  descriptor: ToolDescriptor | undefined,
  grant: ToolGrantState,
): ToolClassification {
  // Unknown tool — the registry has no descriptor (fail-closed, never guessed).
  if (!descriptor) return { lane: 'forbidden', reason: 'unknown_tool' };

  // Default-deny: a tool with no allowing rule (or an explicit deny) is forbidden.
  const rule = grant.rules.get(intended.toolId.toLowerCase());
  if (!rule || !rule.allowed) return { lane: 'forbidden', reason: 'not_allowlisted' };

  // Egress allowlist (SSRF/egress-abuse, §8): the tool's server must resolve to
  // an owner-configured endpoint whose ORIGIN is on the egress allowlist. The
  // endpoint comes from grant-state only — never a model-supplied URL. Shared with
  // `listTools` via `resolveEgressEndpoint` so list + call can never disagree.
  if (resolveEgressEndpoint(descriptor, grant) === null) {
    return { lane: 'forbidden', reason: 'egress_not_allowlisted' };
  }

  const triggers: ToolTrigger[] = [];

  // Sensitive → always ask, regardless of grant/model (00 §6c).
  if (descriptor.sensitive || rule.sensitive) triggers.push('sensitive');

  const policy = rule.perCallPolicy;

  // Per-call arg-size edge (a policy edge, distinct from the hard io-guard cap).
  if (policy?.maxArgBytes !== undefined) {
    const size = JSON.stringify(intended.args ?? {}).length;
    if (size > policy.maxArgBytes) triggers.push('over_arg_size');
  }

  // Recipient novelty: a `recipient`-role authority arg whose value is outside the
  // per-call recipient allowlist asks (never a silent send to a new destination).
  if (policy?.recipientAllowlist && policy.recipientAllowlist.length > 0) {
    const allowed = new Set(policy.recipientAllowlist.map((r) => r.toLowerCase()));
    for (const spec of descriptor.authorityArgs) {
      if (spec.role !== 'recipient') continue;
      const v = intended.args[spec.name];
      if (typeof v === 'string' && !allowed.has(v.toLowerCase())) {
        triggers.push('new_recipient');
      }
    }
  }

  // URL-arg egress lane (SEC M-01, §8): a `url`-role arg is a MODEL-SUPPLIED URL
  // the external tool would reach — an exfiltration/SSRF surface distinct from the
  // proxy endpoint. It is L1-silent ONLY when its origin is in the per-call
  // url-origin allowlist; otherwise it ALWAYS asks (fail-closed — absent/empty
  // allowlist ⇒ no silent fetch to a model-chosen URL).
  const urlAllowed = new Set((policy?.urlOriginAllowlist ?? []).map((o) => o.toLowerCase()));
  for (const spec of descriptor.authorityArgs) {
    if (spec.role !== 'url') continue;
    const v = intended.args[spec.name];
    if (typeof v !== 'string') continue; // a non-string url can't be egressed by the tool as a URL
    const origin = originOf(v);
    if (origin === null || !urlAllowed.has(origin)) triggers.push('new_url');
  }

  if (triggers.length > 0) return { lane: 'l2', triggers: dedupe(triggers) };
  return { lane: 'l1', reason: 'in_policy' };
}

function dedupe(t: ToolTrigger[]): ToolTrigger[] {
  return [...new Set(t)];
}

/**
 * Resolve the owner-configured external MCP endpoint for a descriptor's server,
 * returning it ONLY when its origin is on the egress allowlist — else null
 * (fail-closed). The single source of truth for "can this tool egress at all",
 * shared by `classifyTool` and the provider's `listTools` so a tool can never be
 * listed-but-forbidden or vice-versa (no drift).
 */
export function resolveEgressEndpoint(descriptor: ToolDescriptor, grant: ToolGrantState): string | null {
  const endpoint = grant.serverEndpoints.get(descriptor.server);
  if (!endpoint) return null;
  const origin = originOf(endpoint);
  if (origin === null || !grant.egressAllowlist.has(origin)) return null;
  return endpoint;
}

/** Lowercased `scheme://host[:port]` of a URL, or null if unparseable (fail-closed). */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return null;
  }
}
