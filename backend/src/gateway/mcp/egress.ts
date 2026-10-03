import type { Json } from '../../crypto/canonical.js';
import type { McpCallResult } from './provider.js';
import type { McpEgressClient } from './governed-provider.js';
import type { EgressConfig } from './governed-provider.js';

/**
 * SF-3 egress leg — the mediating proxy's forward to a real external MCP server.
 * The endpoint is ALWAYS the owner-configured, allowlisted URL resolved from
 * grant-state by the gate (never a model-supplied URL — SSRF guard, §8). This
 * client speaks the same streamable-HTTP JSON-RPC 2.0 the LEASH gateway exposes:
 * one `tools/call` request, a JSON response, bounded by a timeout.
 */

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 1_000_000; // hard transport bound; the I/O guard re-caps per-field

export function createHttpMcpEgressClient(timeoutMs = DEFAULT_TIMEOUT_MS): McpEgressClient {
  return {
    async call(endpoint: string, toolName: string, args: Json): Promise<McpCallResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: toolName, arguments: args ?? {} },
          }),
          signal: controller.signal,
        });
        // L-01 hardening: best-effort early reject on a declared Content-Length
        // over the cap (a well-behaved server discloses it). The AUTHORITATIVE
        // bound is the post-read length check below — it covers chunked / omitted-
        // length bodies, which is the case a hostile server controls.
        const declared = Number(res.headers.get('content-length') ?? '0');
        if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
          return { content: [{ type: 'text', text: '[tool response too large]' }], isError: true };
        }
        const text = await res.text();
        if (text.length > MAX_RESPONSE_BYTES) {
          return { content: [{ type: 'text', text: '[tool response too large]' }], isError: true };
        }
        const body = JSON.parse(text) as Record<string, Json>;
        const result = body['result'];
        if (body['error'] || !result || typeof result !== 'object' || Array.isArray(result)) {
          return { content: [{ type: 'text', text: '[tool error]' }], isError: true };
        }
        const content = (result as Record<string, Json>)['content'];
        return {
          content: Array.isArray(content) ? content : [],
          ...((result as Record<string, Json>)['isError'] === true ? { isError: true } : {}),
        };
      } catch {
        return { content: [{ type: 'text', text: '[tool unreachable]' }], isError: true };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Parse the owner/LEASH egress policy from the environment. Empty by default →
 * every tool classifies `egress_not_allowlisted` → forbidden (safe default-deny,
 * identical to SF-1's `denyAllProvider` until the owner configures endpoints).
 *
 * `MCP_SERVER_ENDPOINTS` = JSON `{ "<server>": "<url>", ... }`.
 * `MCP_EGRESS_ALLOWLIST` = comma-separated origins (`scheme://host[:port]`).
 */
export function parseEgressConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EgressConfig {
  let serverEndpoints: Record<string, string> = {};
  const raw = env['MCP_SERVER_ENDPOINTS'];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        serverEndpoints = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).filter(([, v]) => typeof v === 'string'),
        ) as Record<string, string>;
      }
    } catch {
      /* ignore malformed config → empty → default-deny */
    }
  }
  const egressAllowlist = (env['MCP_EGRESS_ALLOWLIST'] ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  return { serverEndpoints, egressAllowlist };
}
