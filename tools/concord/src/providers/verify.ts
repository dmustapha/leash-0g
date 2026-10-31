// providers/verify.ts — runs the named test, parses pass/fail.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import type { EvidenceDemand, ProviderResult } from '../types.js';

const defaultRun = promisify(execFile);

// Injectable command runner so unit tests stay hermetic (no real forge/vitest).
export type CommandRunner = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout: number },
) => Promise<{ stdout: string }>;

export async function verifyProvider(d: EvidenceDemand, run: CommandRunner = defaultRun): Promise<ProviderResult> {
  // d.check = a test selector, e.g. "forge test --match-test test_rolling_window"
  //           or "pnpm vitest run backend/test/unit/keycrypt.test.ts"
  const [cmd, ...args] = d.check.split(' ');
  try {
    const { stdout } = await run(cmd, args, { cwd: process.cwd(), timeout: 600_000 });
    const hash = createHash('sha256').update(stdout).digest('hex').slice(0, 16);
    return { satisfied: true, evidence_ref: `verify:${cmd}:${hash}`, detail: stdout.slice(-400) };
  } catch (e: any) {
    const hash = createHash('sha256').update(String(e.stdout ?? e)).digest('hex').slice(0, 16);
    return { satisfied: false, evidence_ref: `verify-fail:${hash}`, detail: String(e.stdout ?? e).slice(-400) };
  }
}
