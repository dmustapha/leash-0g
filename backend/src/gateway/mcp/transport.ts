import type { Json } from '../../crypto/canonical.js';
import type { AgentRow } from '../../types.js';
import { McpToolForbidden, type McpTenantContext, type McpToolProvider } from './provider.js';

/**
 * SF-1 / BR-F2 — MCP streamable-HTTP transport (JSON-RPC 2.0 over a single
 * `POST /mcp`). Stateless: every request re-authenticates via the gateway
 * bearer (`agent-auth.ts`), so there is no server-side session to fixate or
 * replay across agents, and the transport scales horizontally like the rest of
 * the gateway. Responses are JSON (no SSE streaming in v1 — same honest
 * streaming caveat as the Anthropic adapter, `00 §5b`).
 *
 * Tenant scoping (F-1b): the tenant context is built HERE, from the
 * authenticated agent only; `params` is never consulted for identity. A request
 * that embeds an `agentId`/tenant field cannot widen or redirect its scope.
 */

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'leash-gateway', version: '1.0.0' };

// JSON-RPC error codes (spec + LEASH): parse/invalid/method, plus a dedicated
// forbidden code for default-deny tool refusal (distinct from method-not-found).
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;
const ERR_FORBIDDEN = -32003;

export interface McpHandleResult {
  /** HTTP status for the transport response. */
  status: number;
  /** JSON body, or null for an accepted notification (HTTP 202, no body). */
  body: Json | null;
}

export async function handleMcpRequest(
  provider: McpToolProvider,
  agent: AgentRow,
  body: Json,
): Promise<McpHandleResult> {
  if (!isObject(body) || body['jsonrpc'] !== '2.0' || typeof body['method'] !== 'string') {
    return jsonRpcError(null, ERR_INVALID_REQUEST, 'invalid JSON-RPC request');
  }
  const id = normalizeId(body['id']);
  const method = body['method'];
  const params = isObject(body['params']) ? body['params'] : {};

  // Notifications (no id) are acknowledged, never answered (JSON-RPC 2.0).
  const isNotification = !('id' in body) || body['id'] === undefined;

  const ctx: McpTenantContext = { agentId: agent.id, ownerAddr: agent.ownerAddr };

  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return { status: 202, body: null };
    case 'ping':
      return ok(id, {});
    case 'tools/list': {
      const tools = await provider.listTools(ctx);
      return ok(id, { tools: tools.map(toWireDescriptor) });
    }
    case 'tools/call':
      return callTool(provider, ctx, id, params);
    default:
      if (isNotification) return { status: 202, body: null };
      return jsonRpcError(id, ERR_METHOD_NOT_FOUND, `method not found: ${method}`);
  }
}

async function callTool(
  provider: McpToolProvider,
  ctx: McpTenantContext,
  id: Json,
  params: Record<string, Json>,
): Promise<McpHandleResult> {
  const name = params['name'];
  if (typeof name !== 'string' || name.length === 0) {
    return jsonRpcError(id, ERR_INVALID_PARAMS, 'tools/call requires a string `name`');
  }
  const args = params['arguments'] ?? {};
  try {
    const result = await provider.callTool(ctx, name, args);
    return ok(id, { content: result.content, ...(result.isError ? { isError: true } : {}) });
  } catch (err) {
    if (err instanceof McpToolForbidden) {
      return jsonRpcError(id, ERR_FORBIDDEN, err.message);
    }
    throw err;
  }
}

function toWireDescriptor(d: { name: string; description?: string; inputSchema: Json }): Json {
  return {
    name: d.name,
    ...(d.description ? { description: d.description } : {}),
    inputSchema: d.inputSchema,
  };
}

function ok(id: Json, result: Json): McpHandleResult {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function jsonRpcError(id: Json, code: number, message: string): McpHandleResult {
  // Transport-level framing errors still ride HTTP 200 with a JSON-RPC error
  // body (JSON-RPC convention); auth failures are handled above this layer and
  // use real HTTP 401/403.
  return { status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

function normalizeId(id: Json | undefined): Json {
  if (typeof id === 'string' || typeof id === 'number') return id;
  return null;
}

function isObject(v: Json | undefined): v is Record<string, Json> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
