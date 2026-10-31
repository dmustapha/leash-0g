import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import type { Objection } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Schemas live at <pkg>/schemas; from dist/ that is ../schemas.
const SCHEMA_DIR = join(__dirname, '..', 'schemas');

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

const objectionsSchema = JSON.parse(readFileSync(join(SCHEMA_DIR, 'objections.schema.json'), 'utf8'));
const entrySchema = JSON.parse(readFileSync(join(SCHEMA_DIR, 'concord-entry.schema.json'), 'utf8'));

const validateObjections = ajv.compile(objectionsSchema);
const validateEntry = ajv.compile(entrySchema);

export interface ValidationResult { ok: boolean; errors: string }

// Validate the Skeptic's output against objections.schema.json. A malformed objection set is
// NEVER silently dropped — the caller treats a failure as an unresolved blocking objection
// (fail-closed, per ARCH §19 prose).
export function validateObjectionSet(value: unknown): ValidationResult {
  const ok = validateObjections(value) as boolean;
  return { ok, errors: ok ? '' : ajv.errorsText(validateObjections.errors) };
}

export function validateConcordEntry(value: unknown): ValidationResult {
  const ok = validateEntry(value) as boolean;
  return { ok, errors: ok ? '' : ajv.errorsText(validateEntry.errors) };
}

// Parse + validate a raw objections payload into Objection[]. Throws on malformed input so the
// enforce path fails closed (never returns an empty/partial set silently).
export function parseObjections(raw: unknown): Objection[] {
  const res = validateObjectionSet(raw);
  if (!res.ok) throw new Error(`malformed objection set (fail-closed): ${res.errors}`);
  return (raw as { objections: Objection[] }).objections;
}
