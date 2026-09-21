import type { Json } from '../crypto/canonical.js';
import type { GatewayRule } from '../types.js';

export type InterceptOutcome = (
  | { action: 'observe' }
  | { action: 'block'; rule: GatewayRule }
  | { action: 'modify'; rule: GatewayRule; effective: Json }
  | { action: 'require_approval'; rule: GatewayRule }
) & {
  /** C-5: types of non-text content parts seen in the request (recorded in the trace). */
  nonTextPartTypes: string[];
};

interface ChatMessage {
  role?: string;
  content?: unknown;
}

/**
 * Per-request policy evaluation (spec §3b + C-5): first matching rule wins; no
 * match = observe. Rules match case-insensitively against the message text —
 * which, per C-5, includes OpenAI STRUCTURED content: every `{type:'text'}`
 * part is extracted and the parts are CONCATENATED per message before
 * matching, so a rule phrase split across parts still matches (bypass
 * corpus). Non-text parts (images etc.) cannot be scanned — their types are
 * surfaced for the trace record instead of being silently ignored.
 */
export function evaluateRules(rules: GatewayRule[], body: Json): InterceptOutcome {
  const messages = extractMessages(body);
  const nonTextPartTypes = collectNonTextPartTypes(messages);
  for (const rule of rules) {
    if (!rule.match) continue;
    const needle = rule.match.toLowerCase();
    const hit = messages.some((m) => messageText(m).toLowerCase().includes(needle));
    if (!hit) continue;
    if (rule.action === 'block') return { action: 'block', rule, nonTextPartTypes };
    if (rule.action === 'require_approval') return { action: 'require_approval', rule, nonTextPartTypes };
    if (rule.action === 'modify') {
      return { action: 'modify', rule, effective: applyModify(body, rule), nonTextPartTypes };
    }
  }
  return { action: 'observe', nonTextPartTypes };
}

function extractMessages(body: Json): ChatMessage[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const messages = (body as Record<string, unknown>)['messages'];
  return Array.isArray(messages) ? (messages as ChatMessage[]) : [];
}

/** All scannable text of one message: plain string, or its text parts concatenated. */
function messageText(m: ChatMessage): string {
  if (typeof m.content === 'string') return m.content;
  if (!Array.isArray(m.content)) return '';
  let text = '';
  for (const part of m.content) {
    const t = textOfPart(part);
    if (t !== null) text += t;
  }
  return text;
}

/** A part's text when it IS a text part, else null. */
function textOfPart(part: unknown): string | null {
  if (typeof part === 'string') return part;
  if (part && typeof part === 'object' && !Array.isArray(part)) {
    const p = part as { type?: unknown; text?: unknown };
    if (p.type === 'text' && typeof p.text === 'string') return p.text;
  }
  return null;
}

function collectNonTextPartTypes(messages: ChatMessage[]): string[] {
  const types = new Set<string>();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (textOfPart(part) !== null) continue;
      const t =
        part && typeof part === 'object' && !Array.isArray(part)
          ? String((part as { type?: unknown }).type ?? 'unknown')
          : 'unknown';
      types.add(t);
    }
  }
  return [...types].sort();
}

/**
 * C-5 modify semantics for structured content: consecutive text parts are
 * MERGED into one before replacement (semantically neutral for the model), so
 * a needle split across a part boundary is replaced rather than surviving the
 * rewrite. Non-text parts pass through untouched (they are recorded, not
 * rewritten).
 */
function applyModify(body: Json, rule: GatewayRule): Json {
  const clone = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  const messages = clone['messages'];
  if (Array.isArray(messages)) {
    for (const m of messages as ChatMessage[]) {
      if (typeof m.content === 'string') {
        m.content = replaceAllInsensitive(m.content, rule.match, rule.replacement ?? '');
      } else if (Array.isArray(m.content)) {
        const merged: unknown[] = [];
        for (const part of m.content) {
          const text = textOfPart(part);
          const last = merged[merged.length - 1] as { type?: unknown; text?: unknown } | undefined;
          if (text !== null && last && last.type === 'text' && typeof last.text === 'string') {
            last.text += text;
          } else if (text !== null) {
            merged.push({ type: 'text', text });
          } else {
            merged.push(part);
          }
        }
        for (const part of merged) {
          const p = part as { type?: unknown; text?: unknown };
          if (p.type === 'text' && typeof p.text === 'string') {
            p.text = replaceAllInsensitive(p.text, rule.match, rule.replacement ?? '');
          }
        }
        m.content = merged;
      }
    }
  }
  return clone as Json;
}

function replaceAllInsensitive(haystack: string, needle: string, replacement: string): string {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return haystack.replace(new RegExp(escaped, 'gi'), replacement);
}
