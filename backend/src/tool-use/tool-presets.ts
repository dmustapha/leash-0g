import { GLOBAL_DENY_TOOLS, defaultToolRegistry, type ToolRegistry } from './tool-registry.js';
import type { ToolRule } from './types.js';

/**
 * Tool presets (SF-3) — the broad-grant UX under a default-deny posture, the tool
 * analogue of the capability presets in `governed-call/presets.ts`. A preset is
 * OFF-CHAIN SUGAR: applying one expands to a batch of `ToolRule` grants the owner
 * commits. A preset can NEVER grant a GLOBAL_DENY (sensitive) tool silently — such
 * a tool stays always-ask (L2) by construction even when the preset includes it,
 * because the registry forces `sensitive:true` and the classifier ORs it in. A
 * preset adds NO tool outside the registry (generality guard).
 */

export type ToolPresetKey = 'researcher' | 'communicator' | 'workspace';

interface ToolPresetDef {
  key: ToolPresetKey;
  label: string;
  /** plain-language description for the normie-legible grant UX (00 §2c). */
  description: string;
  /** canonical tool ids this preset grants (must exist in the registry). */
  toolIds: string[];
}

const PRESETS: readonly ToolPresetDef[] = [
  {
    key: 'researcher',
    label: 'Researcher',
    description:
      'Let the agent search the web and read pages. No sending, no writing, no spending. Read-only reach.',
    toolIds: ['search.web_search', 'fetch.fetch_url', 'fs.read_file'],
  },
  {
    key: 'communicator',
    label: 'Communicator',
    description:
      'Research PLUS the ability to send email or post to Slack — but every send ALWAYS asks you first (sensitive tools are never silent).',
    toolIds: ['search.web_search', 'fetch.fetch_url', 'email.send_email', 'slack.post_message'],
  },
  {
    key: 'workspace',
    label: 'Workspace',
    description:
      'Read and write files in the agent workspace. Writes ALWAYS ask you first; reads are silent within the grant.',
    toolIds: ['fs.read_file', 'fs.write_file'],
  },
];

const BY_KEY = new Map<ToolPresetKey, ToolPresetDef>(PRESETS.map((p) => [p.key, p]));

export function toolPresetKeys(): ToolPresetKey[] {
  return PRESETS.map((p) => p.key);
}

export interface ResolvedToolPreset {
  key: ToolPresetKey;
  label: string;
  description: string;
  rules: ToolRule[];
}

/**
 * Expand a preset to concrete `ToolRule` grants against a registry. Returns
 * `null` when a referenced tool id is not in the registry (a preset must be
 * fully resolvable — never a partial grant). Sensitivity is taken from the
 * registry descriptor OR GLOBAL_DENY membership, so a sensitive tool is granted
 * as `sensitive:true` and can never be silently executed.
 */
export function expandToolPreset(
  key: ToolPresetKey,
  registry: ToolRegistry = defaultToolRegistry,
): ResolvedToolPreset | null {
  const def = BY_KEY.get(key);
  if (!def) return null;
  const rules: ToolRule[] = [];
  for (const toolId of def.toolIds) {
    const d = registry.get(toolId);
    if (!d) return null;
    rules.push({
      toolId: d.toolId.toLowerCase(),
      allowed: true,
      sensitive: d.sensitive || GLOBAL_DENY_TOOLS.has(d.toolId.toLowerCase()),
    });
  }
  return { key: def.key, label: def.label, description: def.description, rules };
}
