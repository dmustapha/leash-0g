import { createHash } from 'node:crypto';
import type { ConcordEntry } from './types.js';

// Canonical JSON: keys sorted recursively so the hash is deterministic across runs/machines.
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize((value as any)[k])).join(',') + '}';
}

export function computeEntryHash(entry: Omit<ConcordEntry, 'entry_hash'>): string {
  return createHash('sha256').update(canonicalize(entry)).digest('hex');
}

export function linkEntry(prev: ConcordEntry | null, entry: Omit<ConcordEntry, 'entry_hash' | 'prev_hash'>): ConcordEntry {
  const prev_hash = prev ? prev.entry_hash : '';
  const withPrev = { ...entry, prev_hash };
  const entry_hash = computeEntryHash(withPrev);
  return { ...withPrev, entry_hash };
}

export interface ChainResult { ok: boolean; brokenAt?: number; reason?: string; }

export function verifyChain(entries: ConcordEntry[]): ChainResult {
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const { entry_hash, ...rest } = e;
    if (computeEntryHash(rest) !== entry_hash) return { ok: false, brokenAt: i, reason: 'entry_hash mismatch (tampered body)' };
    const expectedPrev = i === 0 ? '' : entries[i - 1].entry_hash;
    if (e.prev_hash !== expectedPrev) return { ok: false, brokenAt: i, reason: 'prev_hash broken (reordered/spliced)' };
  }
  return { ok: true };
}
