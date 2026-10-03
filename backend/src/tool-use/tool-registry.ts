import type { ToolArgSpec, ToolDescriptor } from './types.js';

/**
 * Canonical tool registry (SF-3) — the authority surface the classifier trusts.
 * Mirror of the on-chain structured-selector set: a tool the registry does not
 * know is `unknown_tool` → forbidden (default-deny, never guessed). Each
 * descriptor declares its authority-carrying arguments (recipients/urls — the
 * exfiltration + SSRF surface, §8) and whether it is SENSITIVE (always-ask,
 * 00 §6c). Registry entries are owner/LEASH-authored, NEVER derived from a
 * tool RESULT or model text (a result can never introduce a new tool — §8
 * tool-chaining escalation).
 *
 * v1 ships a curated built-in set covering the common MCP tool shapes; the
 * registry is a plain lookup so SF-2 / later slices can extend it per bound
 * agent without a classifier change (the generality seam).
 */

const arg = (name: string, role: ToolArgSpec['role']): ToolArgSpec => ({ name, role });

/**
 * Tools that are SENSITIVE by construction — they move data/authority outward
 * (send, publish, pay, delete) and therefore ALWAYS require owner approval
 * regardless of any standing grant or what the model decided (00 §6c). A preset
 * can never suppress this; the descriptor's `sensitive` is OR-ed with membership
 * here (mirror of `GLOBAL_DENY_LIST` in governed-call/presets.ts).
 */
export const GLOBAL_DENY_TOOLS: ReadonlySet<string> = new Set([
  'email.send_email',
  'slack.post_message',
  'fs.write_file',
  'fs.delete_file',
  'payments.transfer',
  'shell.exec',
]);

const BUILT_IN: readonly ToolDescriptor[] = [
  // Read-only research tools (not sensitive): the common "let the agent look
  // things up" surface. `fetch` carries a url authority arg (SSRF-relevant).
  {
    toolId: 'search.web_search',
    server: 'search',
    name: 'web_search',
    description: 'Search the web for a query string.',
    authorityArgs: [],
    sensitive: false,
  },
  {
    toolId: 'fetch.fetch_url',
    server: 'fetch',
    name: 'fetch_url',
    description: 'Fetch the contents of a URL.',
    authorityArgs: [arg('url', 'url')],
    sensitive: false,
  },
  {
    toolId: 'fs.read_file',
    server: 'fs',
    name: 'read_file',
    description: 'Read a file from the agent workspace.',
    authorityArgs: [arg('path', 'content')],
    sensitive: false,
  },
  // Sensitive, outward-moving tools (always-ask).
  {
    toolId: 'email.send_email',
    server: 'email',
    name: 'send_email',
    description: 'Send an email.',
    authorityArgs: [arg('to', 'recipient')],
    sensitive: true,
  },
  {
    toolId: 'slack.post_message',
    server: 'slack',
    name: 'post_message',
    description: 'Post a message to a Slack channel.',
    authorityArgs: [arg('channel', 'recipient')],
    sensitive: true,
  },
  {
    toolId: 'fs.write_file',
    server: 'fs',
    name: 'write_file',
    description: 'Write a file in the agent workspace.',
    authorityArgs: [arg('path', 'content')],
    sensitive: true,
  },
  {
    toolId: 'payments.transfer',
    server: 'payments',
    name: 'transfer',
    description: 'Transfer funds via an external payments API.',
    authorityArgs: [arg('to', 'recipient'), arg('amount', 'amount')],
    sensitive: true,
  },
];

/** A tool registry — a lookup from canonical `toolId` to its descriptor. */
export interface ToolRegistry {
  get(toolId: string): ToolDescriptor | undefined;
  list(): ToolDescriptor[];
}

function withGlobalSensitivity(d: ToolDescriptor): ToolDescriptor {
  // OR the descriptor's own flag with GLOBAL_DENY membership — a preset/registry
  // edit can never drop a globally-sensitive tool below always-ask.
  return GLOBAL_DENY_TOOLS.has(d.toolId) ? { ...d, sensitive: true } : d;
}

/** Build a registry from a descriptor set (defaults to the built-in set). */
export function createToolRegistry(descriptors: readonly ToolDescriptor[] = BUILT_IN): ToolRegistry {
  const byId = new Map<string, ToolDescriptor>();
  for (const d of descriptors) byId.set(d.toolId.toLowerCase(), withGlobalSensitivity(d));
  return {
    get: (toolId) => byId.get(toolId.toLowerCase()),
    list: () => [...byId.values()],
  };
}

/** The default built-in registry. */
export const defaultToolRegistry: ToolRegistry = createToolRegistry();
