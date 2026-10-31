import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ConcordEntry } from './types.js';
import { computeEntryHash, verifyChain } from './hashchain.js';

const LEDGER_DIR = 'concord';

// Exit codes: 0 = merge allowed, 1 = merge blocked (any failure). Fail-closed.
export function headSha(): string { return execFileSync('git', ['rev-parse', 'HEAD']).toString().trim(); }

function loadChain(dir: string): ConcordEntry[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')) as ConcordEntry)
    .sort((a, b) => a.mr_iid - b.mr_iid);
}

// headShaFn and ledgerDir are injectable so the unit test is deterministic (no real git / no CWD
// dependence). Production defaults call git and read ./concord.
export function verifyConcord(
  mr_iid: number,
  headShaFn: () => string = headSha,
  ledgerDir: string = LEDGER_DIR,
): number {
  const path = join(ledgerDir, `${mr_iid}.json`);
  if (!existsSync(path)) { console.error(`BLOCK: no concord entry for MR ${mr_iid}`); return 1; }
  const entry = JSON.parse(readFileSync(path, 'utf8')) as ConcordEntry;

  // 1. verdict must be AGREE
  if (entry.verdict !== 'AGREE') { console.error('BLOCK: verdict is NO_AGREE'); return 1; }
  // 2. entry hash must recompute (no tamper)
  const { entry_hash, ...rest } = entry;
  if (computeEntryHash(rest) !== entry_hash) { console.error('BLOCK: entry_hash mismatch (tampered)'); return 1; }
  // 3. head_sha must equal current HEAD (no post-approval sneak commit)
  if (entry.head_sha !== headShaFn()) { console.error('BLOCK: head_sha != HEAD (code changed after verdict)'); return 1; }
  // 4. full chain must be intact
  const chain = loadChain(ledgerDir);
  const chainResult = verifyChain(chain);
  if (!chainResult.ok) {
    console.error(`BLOCK: chain broken at ${chainResult.brokenAt}: ${chainResult.reason}`);
    return 1;
  }

  console.log('ALLOW: concord entry valid for HEAD');
  return 0;
}

// verify-chain subcommand: 0 if the whole concord/ chain is intact, else 1.
export function verifyChainCmd(ledgerDir: string = LEDGER_DIR): number {
  const chain = loadChain(ledgerDir);
  const res = verifyChain(chain);
  if (!res.ok) {
    console.error(`BLOCK: chain broken at ${res.brokenAt}: ${res.reason}`);
    return 1;
  }
  console.log(`ALLOW: chain intact (${chain.length} entries)`);
  return 0;
}
