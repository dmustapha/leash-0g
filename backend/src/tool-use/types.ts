/**
 * Governed tool-use grammar — off-chain types (Stage F, SF-3).
 *
 * This module is the OFF-CHAIN tool analogue of `governed-call/`. Where
 * `governed-call/` narrows the on-chain money surface against the `LeashAccountV4`
 * wall, tool-use governs the NEW off-chain gateway surface — MCP tool calls — for
 * which there is NO on-chain backstop (STAGE-F §8). The gateway egress proxy is
 * the SOLE boundary, so every type here is fail-closed by construction:
 *   - default-deny: a tool with no allowing rule is `forbidden` (never surfaced);
 *   - grant-state only: classification reads owner-authored policy, NEVER model
 *     text or a tool RESULT (a result can never widen the allowlist, §8
 *     tool-chaining escalation);
 *   - sensitive-always-ask: a sensitive tool is `l2` regardless of what the model
 *     "decided" (00 §6c — reasoning is never trusted for authority).
 *
 * Mirror of the three-lane model in `governed-call/types.ts`.
 */

/**
 * The role an argument plays for authority. Mirrors `AuthorityArgs` in the
 * on-chain grammar: the classifier only looks at arguments whose role carries
 * authority (a recipient/url/target), never free-form content.
 */
export type ToolArgRole =
  /** a destination the result/data flows TO (exfiltration-relevant): email, address, webhook. */
  | 'recipient'
  /** a URL/endpoint the tool would reach (SSRF-relevant). */
  | 'url'
  /** a chargeable/bounded magnitude. */
  | 'amount'
  /** free-form content (scanned by the I/O guard, never authority-classified). */
  | 'content';

/** A declared authority argument of a tool (owner-authored registry, never model text). */
export interface ToolArgSpec {
  /** the argument key in the tool's `arguments` object. */
  name: string;
  role: ToolArgRole;
}

/**
 * A canonical tool descriptor (the registry entry). Owner/registry-authored —
 * the authority surface the classifier trusts. A tool the registry does not
 * know is `unknown_tool` → forbidden (default-deny).
 */
export interface ToolDescriptor {
  /** canonical tool id `${server}.${tool}` (lowercased). */
  toolId: string;
  /** logical external MCP server key (resolved to an allowlisted endpoint at egress). */
  server: string;
  /** the model-facing tool name as exposed over MCP (tools/list + tools/call). */
  name: string;
  description?: string;
  /** authority-carrying arguments (recipients/urls) — the only args classify inspects. */
  authorityArgs: ToolArgSpec[];
  /**
   * sensitive = ALWAYS requires owner approval regardless of grant-state or model
   * intent (00 §6c). A sensitive tool can never classify L1. GLOBAL_DENY tools are
   * sensitive by construction (tool-presets.ts).
   */
  sensitive: boolean;
}

/** Per-tool policy knobs (v1 structured; no condition-tree — the §9 seam). */
export interface ToolPerCallPolicy {
  /** max serialized bytes of the `arguments` object (edge → L2 when exceeded). */
  maxArgBytes?: number;
  /** allowed recipient values for `recipient`-role args (lowercased); empty/absent = any within the standing grant. */
  recipientAllowlist?: string[];
  /**
   * allowed ORIGINS (`scheme://host[:port]`, lowercased) for `url`-role args — the
   * model-supplied-URL egress/exfiltration lane (SEC M-01, §8). A `url`-role arg is
   * only L1-silent when its origin is in this set; otherwise it raises L2 (ask).
   * Absent/empty ⇒ a `url`-role arg ALWAYS asks (fail-closed: no silent fetch to a
   * model-chosen URL).
   */
  urlOriginAllowlist?: string[];
}

/** The owner's standing grant for one tool (server mirror; the gateway proxy is authority). */
export interface ToolRule {
  toolId: string;
  /** false ⇒ explicitly denied (forbidden); absent rule ⇒ also forbidden (default-deny). */
  allowed: boolean;
  perCallPolicy?: ToolPerCallPolicy;
  /** owner-escalated sensitivity (ORs with the descriptor's sensitive flag). */
  sensitive: boolean;
}

/**
 * The tool grant-state the classifier reads (owner-authored mirror). Authority is
 * the gateway proxy enforcement — these rows only mirror what the owner granted.
 */
export interface ToolGrantState {
  /** granted tool rules keyed by lowercased `toolId`. */
  rules: Map<string, ToolRule>;
  /**
   * egress allowlist: the set of external MCP endpoint ORIGINS the proxy may
   * forward to (lowercased `scheme://host[:port]`). An endpoint off this set is
   * refused (SSRF/egress-abuse guard, §8). Owner-configured, never model-supplied.
   */
  egressAllowlist: Set<string>;
  /**
   * logical server key → concrete external MCP endpoint URL (owner-configured).
   * The classifier/proxy resolves a descriptor's `server` here; a missing or
   * off-allowlist endpoint is forbidden.
   */
  serverEndpoints: Map<string, string>;
}

/** Classification of an intended tool call (the three-lane model, mirror of `Classification`). */
export type ToolClassification =
  | { lane: 'l1'; reason: 'in_policy' }
  | { lane: 'l2'; triggers: ToolTrigger[] }
  | { lane: 'forbidden'; reason: ToolForbiddenReason };

/** L2 (JIT-ask) triggers — a standing grant exists but the call needs owner consent. */
export type ToolTrigger =
  /** the tool is sensitive (descriptor or rule) — always ask (00 §6c). */
  | 'sensitive'
  /** an authority arg is outside its per-call policy (e.g. new recipient). */
  | 'new_recipient'
  /** a `url`-role arg's origin is outside the per-call url-origin allowlist (SEC M-01). */
  | 'new_url'
  /** serialized args exceed the per-call byte policy. */
  | 'over_arg_size';

/** Forbidden reasons — fail-closed, never surfaced as L1/L2. */
export type ToolForbiddenReason =
  /** the registry has no descriptor for this tool id. */
  | 'unknown_tool'
  /** no allowing rule (default-deny) or an explicit `allowed:false`. */
  | 'not_allowlisted'
  /** the tool's server resolves to no endpoint, or an off-allowlist endpoint (SSRF guard). */
  | 'egress_not_allowlisted'
  /** the args/result failed the I/O guard (size/depth/proto-pollution/bidi/type-smuggle). */
  | 'io_rejected';
