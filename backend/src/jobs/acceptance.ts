import { z } from 'zod';
import type { Json } from '../crypto/canonical.js';

/**
 * The deterministic acceptance FLOOR (spec §3d.1, F2) — layer 1 of the
 * verification gate. A GENERIC, config-driven rule engine: it is NOT a
 * prediction-specific validator (generality guard). The job spec's
 * `acceptanceRef` selects a rule set from the owner-defined registry; each rule
 * checks the deliverable in PURE CODE (no LLM), so a sycophantic evaluator can
 * never rubber-stamp malformed/garbage work.
 *
 * HONEST LIMIT (spec §3d.1): this is a STRUCTURAL floor (conformance) — it
 * proves the shape/ranges/required fields, NOT semantic quality. Semantic
 * quality is the evaluator's + the evals' + the owner's job. A schema-valid but
 * WRONG deliverable passes the floor and must be caught downstream (the
 * layering-proof eval, F7-limit).
 */

export const ruleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('required'), path: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('type'), path: z.string().min(1), type: z.enum(['string', 'number', 'boolean', 'object', 'array']) }).strict(),
  z.object({ kind: z.literal('numberRange'), path: z.string().min(1), min: z.number().optional(), max: z.number().optional() }).strict(),
  z.object({ kind: z.literal('stringLength'), path: z.string().min(1), min: z.number().int().nonnegative().optional(), max: z.number().int().positive().optional() }).strict(),
  z.object({ kind: z.literal('enum'), path: z.string().min(1), values: z.array(z.union([z.string(), z.number(), z.boolean()])).min(1) }).strict(),
  z.object({ kind: z.literal('arrayMinLength'), path: z.string().min(1), min: z.number().int().nonnegative() }).strict(),
]);

export const acceptanceRuleSetSchema = z
  .object({
    /** Human label for the cockpit; not load-bearing. */
    label: z.string().max(200).optional(),
    rules: z.array(ruleSchema).min(1).max(64),
  })
  .strict();

export type AcceptanceRuleSet = z.infer<typeof acceptanceRuleSetSchema>;
export type AcceptanceRule = z.infer<typeof ruleSchema>;

export interface AcceptanceResult {
  passed: boolean;
  /** One failure message per violated rule (ordered) — plain language for the cockpit. */
  failures: string[];
  /** Count of rules evaluated (for evidence). */
  checked: number;
}

/**
 * Render the rule set as a concrete field contract for the PROVIDER prompt
 * (D-JOB-10 fix). The acceptance rules are the authoritative deliverable schema
 * (`deliverableSchemaRef` is only an opaque handle), so the provider model must
 * be TOLD the exact fields/types/ranges — otherwise it invents a shape that the
 * deterministic floor rejects. This is descriptive only; the floor stays the
 * authoritative gate.
 */
export function renderAcceptanceContract(ruleSet: AcceptanceRuleSet): string {
  const byPath = new Map<string, string[]>();
  const add = (path: string, note: string) => {
    const list = byPath.get(path) ?? [];
    list.push(note);
    byPath.set(path, list);
  };
  for (const rule of ruleSet.rules) {
    switch (rule.kind) {
      case 'required':
        add(rule.path, 'required');
        break;
      case 'type':
        add(rule.path, `type ${rule.type}`);
        break;
      case 'numberRange': {
        const bounds = [rule.min !== undefined ? `>= ${rule.min}` : '', rule.max !== undefined ? `<= ${rule.max}` : '']
          .filter(Boolean)
          .join(' and ');
        add(rule.path, `a number${bounds ? ` ${bounds}` : ''}`);
        break;
      }
      case 'stringLength': {
        const bounds = [rule.min !== undefined ? `at least ${rule.min}` : '', rule.max !== undefined ? `at most ${rule.max}` : '']
          .filter(Boolean)
          .join(' and ');
        add(rule.path, `a string${bounds ? ` (${bounds} chars)` : ''}`);
        break;
      }
      case 'enum':
        add(rule.path, `one of ${JSON.stringify(rule.values)}`);
        break;
      case 'arrayMinLength':
        add(rule.path, `an array with at least ${rule.min} item(s)`);
        break;
    }
  }
  const lines = [...byPath.entries()].map(([path, notes]) => `- "${path}": ${notes.join(', ')}`);
  return [
    'The deliverable JSON MUST contain these fields (dotted paths are nested keys):',
    ...lines,
    'Put these fields at exactly these paths — do not nest them under a wrapper object.',
  ].join('\n');
}

/** Resolve a dotted path (`a.b.0.c`) against a JSON value. undefined if absent. */
function resolvePath(root: Json | undefined, path: string): Json | undefined {
  let cur: unknown = root;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur as Json | undefined;
}

function typeOf(v: unknown): string {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  return typeof v;
}

/**
 * Evaluate a deliverable against a rule set. Pure, deterministic, no LLM, no IO.
 * Returns ALL failures (not just the first) so the cockpit can show every gap.
 */
export function evaluateAcceptance(deliverable: Json | undefined, ruleSet: AcceptanceRuleSet): AcceptanceResult {
  const failures: string[] = [];
  for (const rule of ruleSet.rules) {
    const v = resolvePath(deliverable, rule.path);
    switch (rule.kind) {
      case 'required':
        if (v === undefined || v === null) failures.push(`missing required field "${rule.path}"`);
        break;
      case 'type':
        if (v !== undefined && typeOf(v) !== rule.type) {
          failures.push(`field "${rule.path}" must be ${rule.type}, got ${typeOf(v)}`);
        }
        break;
      case 'numberRange':
        if (typeof v !== 'number' || Number.isNaN(v)) {
          failures.push(`field "${rule.path}" must be a number`);
        } else {
          if (rule.min !== undefined && v < rule.min) failures.push(`field "${rule.path}" (${v}) below min ${rule.min}`);
          if (rule.max !== undefined && v > rule.max) failures.push(`field "${rule.path}" (${v}) above max ${rule.max}`);
        }
        break;
      case 'stringLength':
        if (typeof v !== 'string') {
          failures.push(`field "${rule.path}" must be a string`);
        } else {
          if (rule.min !== undefined && v.length < rule.min) failures.push(`field "${rule.path}" shorter than ${rule.min} chars`);
          if (rule.max !== undefined && v.length > rule.max) failures.push(`field "${rule.path}" longer than ${rule.max} chars`);
        }
        break;
      case 'enum':
        if (!rule.values.includes(v as string | number | boolean)) {
          failures.push(`field "${rule.path}" must be one of ${JSON.stringify(rule.values)}`);
        }
        break;
      case 'arrayMinLength':
        if (!Array.isArray(v) || v.length < rule.min) {
          failures.push(`field "${rule.path}" must be an array of at least ${rule.min}`);
        }
        break;
    }
  }
  return { passed: failures.length === 0, failures, checked: ruleSet.rules.length };
}
