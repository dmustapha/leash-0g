// providers/secure.ts — runs gitleaks/SAST on the diff; clean => satisfied.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { EvidenceDemand, ProviderResult } from '../types.js';

const defaultRun = promisify(execFile);

// Injectable runner so unit tests stay hermetic (no real gitleaks binary required).
export type ShellRunner = (
  cmd: string,
  args: string[],
  opts: { timeout: number },
) => Promise<{ stdout: string }>;

export async function secureProvider(d: EvidenceDemand, run: ShellRunner = defaultRun): Promise<ProviderResult> {
  // d.check = "gitleaks protect --staged" or a SAST invocation; expect "clean"
  try {
    await run('bash', ['-lc', d.check], { timeout: 300_000 });
    return { satisfied: true, evidence_ref: `secure:clean:${Date.now()}` };
  } catch (e: any) {
    return { satisfied: false, evidence_ref: `secure:findings`, detail: String(e.stdout ?? e).slice(-400) };
  }
}
