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
    // C-SF3-1: a model-supplied url-role arg pointing at an internal/loopback/
    // metadata/private host ALWAYS asks (never silent), even if its origin were
    // somehow allowlisted — the owner must consent to any internal fetch.
    if (origin === null || !urlAllowed.has(origin) || isInternalUrl(v)) triggers.push('new_url');
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

/**
 * C-SF3-1 (SSRF guard, §8): is a hostname an internal / loopback / link-local /
 * cloud-metadata / private-range target the mediating egress proxy must never be
 * coerced into reaching? Used at config-parse time (reject such an egress
 * allowlist origin unless explicitly opted in) AND on model-supplied `url`-role
 * args (which can never silently fetch an internal host). Fail-closed: an
 * unparseable/empty host is treated as internal.
 *
 * INVARIANT (SD-F7 re-audit LOW): callers MUST pass a URL-NORMALIZED hostname
 * (i.e. `new URL(x).hostname`), never a raw user string. WHATWG URL
 * canonicalizes octal/decimal/0x/mixed-case IP encodings to dotted-quad before
 * this predicate sees them; all current callers (isInternalUrl, egress config
 * parse) do. A future caller passing a raw host would reopen those encodings.
 */
export function isInternalHost(host: string): boolean {
  if (!host) return true;
  let h = host.toLowerCase().trim();
  // Strip IPv6 brackets; only strip a trailing :port on a bracketed or dotted-quad
  // host — never last-colon-truncate a bare IPv6 literal (L-01 footgun).
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    h = end === -1 ? h.slice(1) : h.slice(1, end); // also drops any :port after ]
  } else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(h)) {
    h = h.slice(0, h.lastIndexOf(':'));
  }
  // Trailing-dot FQDN is DNS-equivalent to the dotless form (H-01) — normalize
  // before the suffix/exact checks or `metadata.google.internal.` sails through.
  if (h.endsWith('.')) h = h.slice(0, -1);
  // IPv4-mapped IPv6 (H-01): `::ffff:169.254.169.254` (dotted) and the hex-group
  // form `::ffff:a9fe:a9fe` that `new URL().hostname` emits — re-check as IPv4 or
  // the cloud-metadata endpoint reaches the proxy as a non-internal host.
  const mappedDotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (mappedDotted?.[1]) return isInternalHost(mappedDotted[1]);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (mappedHex?.[1] && mappedHex[2]) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isInternalHost(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  // NAT64 (64:ff9b::/96, RFC 6052, tear-apart 2026-10-13): a public IPv4 embedded
  // in IPv6; where the deployment routes NAT64, the cloud-metadata IP reaches the
  // proxy as `64:ff9b::a9fe:a9fe`. Extract the embedded IPv4 (hex-group form that
  // `new URL().hostname` emits, or dotted) and re-check — mirroring ::ffff:, so a
  // legit public NAT64 address (64:ff9b::8.8.8.8) is NOT over-blocked.
  // RELIES ON the WHATWG-URL invariant above: URL.hostname always emits the
  // compressed `::` form, so these regexes see it; a future caller violating the
  // invariant with a non-compressed `64:ff9b:0:0:0:0:a9fe:a9fe` would bypass here.
  // Scoped to the IANA well-known /96 only — network-specific RFC-6052 §2.1
  // prefixes are not universally routable, intentionally out of scope.
  const nat64Dotted = /^64:ff9b::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (nat64Dotted?.[1]) return isInternalHost(nat64Dotted[1]);
  const nat64Hex = /^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (nat64Hex?.[1] && nat64Hex[2]) {
    const hi = parseInt(nat64Hex[1], 16);
    const lo = parseInt(nat64Hex[2], 16);
    return isInternalHost(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
  if (h === 'metadata' || h === 'metadata.google.internal') return true;
  // IPv6 loopback / unspecified / non-compressed loopback / unique-local
  // (fc00::/7) / link-local (fe80::/10).
  if (h === '::1' || h === '::') return true;
  if (/^(0:){7}0*1$/.test(h)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)) return true;
  // IPv4 dotted-quad ranges.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 0 || a === 10) return true; // loopback / this-host / private
    if (a === 169 && b === 254) return true; // link-local + cloud metadata (169.254.169.254)
    if (a === 192 && b === 168) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (100.64/10)
  }
  return false;
}

/** isInternalHost applied to a full URL string (fail-closed on parse failure). */
export function isInternalUrl(url: string): boolean {
  try {
    return isInternalHost(new URL(url).hostname);
  } catch {
    return true;
  }
}
