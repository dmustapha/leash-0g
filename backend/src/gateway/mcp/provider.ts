import type { Json } from '../../crypto/canonical.js';

/**
 * SF-1 / BR-F2 — the MCP tool-provider seam.
 *
 * The MCP transport (`transport.ts`) owns protocol framing + per-agent auth +
 * tenant scoping; WHICH tools a tenant may list/call is delegated to a provider
 * so SF-3 (governed tool-use) can plug the registry-backed, policy-enforcing
 * provider in with NO transport change (the SPINE carries the rider). SF-1
 * ships only the `denyAllProvider` — a transport that authenticates, scopes to
 * a tenant, and default-denies every tool (no tool policy is built in SF-1).
 *
 * The tenant context is ALWAYS constructed by the transport from the bearer
 * token's agent (M-01 discipline: identity derives ONLY from the token). A
 * provider therefore cannot be handed a client-controlled tenant — cross-tenant
 * access is structurally impossible, not merely checked (F-1b).
 */
export interface McpTenantContext {
  /** The authenticated agent — the tenant. Never client-supplied. */
  readonly agentId: string;
  /** The agent's owner (lowercased) — for owner-scoped tool resolution in SF-3. */
  readonly ownerAddr: string;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema: Json;
}

export interface McpCallResult {
  /** MCP tool-result content blocks. */
  content: Json[];
  isError?: boolean;
}

/** Raised by a provider when a tool is not available to the tenant (default-deny). */
export class McpToolForbidden extends Error {
  constructor(public readonly toolName: string) {
    super(`tool not available in this tenant scope`);
    this.name = 'McpToolForbidden';
  }
}

export interface McpToolProvider {
  listTools(ctx: McpTenantContext): Promise<McpToolDescriptor[]>;
  callTool(ctx: McpTenantContext, name: string, args: Json): Promise<McpCallResult>;
}

/**
 * SF-1 default provider: no tenant has any tool. `listTools` is empty and every
 * `callTool` is forbidden (default-deny, `07 S28`). SF-3 replaces this with the
 * registry-backed governed provider.
 */
export const denyAllProvider: McpToolProvider = {
  async listTools(): Promise<McpToolDescriptor[]> {
    return [];
  },
  async callTool(_ctx: McpTenantContext, name: string): Promise<McpCallResult> {
    throw new McpToolForbidden(name);
  },
};
