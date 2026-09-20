import type { Json } from '../crypto/canonical.js';
import type { GatewayRule } from '../types.js';

export type InterceptOutcome =
  | { action: 'observe' }
  | { action: 'block'; rule: GatewayRule }
  | { action: 'modify'; rule: GatewayRule; effective: Json }
  | { action: 'require_approval'; rule: GatewayRule };

interface ChatMessage {
  role?: string;
  content?: unknown;
}

/**
 * Per-request policy evaluation (spec §3b): first matching rule wins; no match
 * = observe. Rules match case-insensitively against every string message
 * content in the OpenAI-shaped request.
 */
export function evaluateRules(rules: GatewayRule[], body: Json): InterceptOutcome {
  const messages = extractMessages(body);
  for (const rule of rules) {
    if (!rule.match) continue;
    const needle = rule.match.toLowerCase();
    const hit = messages.some((m) => typeof m.content === 'string' && m.content.toLowerCase().includes(needle));
    if (!hit) continue;
    if (rule.action === 'block') return { action: 'block', rule };
    if (rule.action === 'require_approval') return { action: 'require_approval', rule };
    if (rule.action === 'modify') {
      return { action: 'modify', rule, effective: applyModify(body, rule) };
    }
  }
  return { action: 'observe' };
}

function extractMessages(body: Json): ChatMessage[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const messages = (body as Record<string, unknown>)['messages'];
  return Array.isArray(messages) ? (messages as ChatMessage[]) : [];
}

function applyModify(body: Json, rule: GatewayRule): Json {
  const clone = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  const messages = clone['messages'];
  if (Array.isArray(messages)) {
    for (const m of messages as ChatMessage[]) {
      if (typeof m.content === 'string') {
        m.content = replaceAllInsensitive(m.content, rule.match, rule.replacement ?? '');
      }
    }
  }
  return clone as Json;
}

function replaceAllInsensitive(haystack: string, needle: string, replacement: string): string {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return haystack.replace(new RegExp(escaped, 'gi'), replacement);
}
