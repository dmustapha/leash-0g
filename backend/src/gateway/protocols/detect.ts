import type { Json } from '../../crypto/canonical.js';

/**
 * SF-1 (F-1c): protocol detection is exact-path/exact-shape. A request is
 * routed to a protocol ONLY when BOTH its path and its body shape match that
 * protocol exactly; anything ambiguous or unknown is REFUSED, never guessed
 * (fail-closed — mirrors the gateway's "exact-path, nothing else" discipline).
 *
 * `/v1/chat/completions` keeps its legacy behaviour untouched (regression): its
 * shape is NOT re-validated here — the existing route forwards as before. The
 * new `/v1/messages` (Anthropic) and `/mcp` (MCP) surfaces are strict: a body
 * that does not match the protocol's exact shape yields `null` → the route
 * refuses with 400 rather than attempting a best-effort guess.
 */
export type Protocol = 'openai' | 'anthropic' | 'mcp';

export function detectProtocol(path: string, body: Json): Protocol | null {
  if (path === '/v1/chat/completions') return 'openai';
  if (path === '/v1/messages') return isAnthropicRequestShape(body) ? 'anthropic' : null;
  if (path === '/mcp') return isJsonRpcShape(body) ? 'mcp' : null;
  return null;
}

const ANTHROPIC_ROLES = new Set(['user', 'assistant']);
const KNOWN_BLOCK_TYPES = new Set(['text', 'tool_use', 'tool_result', 'image']);

/**
 * Strict Anthropic Messages API request shape. The discriminators that reject a
 * smuggled OpenAI body (protocol-confusion, §8): `max_tokens` is REQUIRED
 * (Anthropic mandates it; OpenAI does not), roles are limited to user/assistant
 * (OpenAI also uses system/tool in `messages[]`), and every content block type
 * must be known (an unknown block type is shape-smuggling → refuse).
 */
export function isAnthropicRequestShape(body: Json): boolean {
  if (!isObject(body)) return false;
  if (typeof body['model'] !== 'string' || body['model'].length === 0) return false;
  if (typeof body['max_tokens'] !== 'number' || !Number.isInteger(body['max_tokens']) || body['max_tokens'] <= 0) {
    return false;
  }
  const messages = body['messages'];
  if (!Array.isArray(messages) || messages.length === 0) return false;
  for (const m of messages) {
    if (!isObject(m)) return false;
    if (typeof m['role'] !== 'string' || !ANTHROPIC_ROLES.has(m['role'])) return false;
    if (!isValidAnthropicContent(m['content'])) return false;
  }
  if ('system' in body && !isValidSystem(body['system'])) return false;
  return true;
}

const KNOWN_RESULT_SUBTYPES = new Set(['text', 'image']);

function isValidAnthropicContent(content: Json | undefined): boolean {
  if (typeof content === 'string') return true;
  if (!Array.isArray(content)) return false;
  for (const block of content) {
    if (!isObject(block)) return false;
    const type = block['type'];
    if (typeof type !== 'string' || !KNOWN_BLOCK_TYPES.has(type)) return false;
    // Exact-shape, fail-closed (SEC H-01): a tool_result's nested content is
    // validated too — a string, or an array of known sub-blocks. This mirrors
    // `isValidSystem` and prevents an unknown nested shape from slipping the
    // top-level gate (the mapping is also lossless, defence in depth).
    if (type === 'tool_result' && !isValidToolResultContent(block['content'])) return false;
  }
  return true;
}

function isValidToolResultContent(content: Json | undefined): boolean {
  if (content === undefined || typeof content === 'string') return true;
  if (!Array.isArray(content)) return false;
  return content.every((b) => isObject(b) && typeof b['type'] === 'string' && KNOWN_RESULT_SUBTYPES.has(b['type']));
}

function isValidSystem(system: Json): boolean {
  if (typeof system === 'string') return true;
  if (!Array.isArray(system)) return false;
  return system.every((b) => isObject(b) && b['type'] === 'text' && typeof b['text'] === 'string');
}

/** Minimal JSON-RPC 2.0 envelope check (method present, jsonrpc === '2.0'). */
export function isJsonRpcShape(body: Json): boolean {
  if (!isObject(body)) return false;
  if (body['jsonrpc'] !== '2.0') return false;
  return typeof body['method'] === 'string';
}

function isObject(v: Json | undefined): v is Record<string, Json> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
