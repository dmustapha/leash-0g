import 'dotenv/config';

/** Live tests hit real 0G testnet infra — every var must come from .env. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} required in backend/.env for live tests`);
  return value;
}

export const COMPUTE_BASE_URL = process.env['COMPUTE_BASE_URL'] ?? 'https://router-api.0g.ai/v1';
export const LIVE_MODEL = process.env['RUNTIME_DEFAULT_MODEL'] ?? '0gm-1.0-35b-a3b';

export async function retry<T>(fn: () => Promise<T>, attempts: number, delayMs: number): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * C-4: per-scenario eval artifacts — written on EVERY run, uploaded by CI only
 * when the lane fails, so a red lane always ships its raw model output for
 * diagnosis instead of a bare assertion message.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ARTIFACT_DIR = fileURLToPath(new URL('./artifacts', import.meta.url));

export function writeEvalArtifact(name: string, data: unknown): void {
  try {
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 80);
    writeFileSync(`${ARTIFACT_DIR}/${slug}.json`, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('eval artifact write failed:', err);
  }
}
