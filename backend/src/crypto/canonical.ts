/**
 * Canonical JSON: deterministic serialization used for trace hash-chaining.
 * Object keys are sorted lexicographically at every depth; array order is
 * preserved; undefined properties are dropped (matching JSON.stringify);
 * non-finite numbers are rejected (they would serialize as null and silently
 * change the hash preimage).
 */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json | undefined };

export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number ${value}`);
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? 'null' : serialize(v))).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${serialize(obj[k])}`);
  return `{${parts.join(',')}}`;
}
