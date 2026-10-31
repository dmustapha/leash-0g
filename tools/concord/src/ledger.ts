import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ConcordEntry, Round, Verdict } from './types.js';
import { linkEntry, verifyChain } from './hashchain.js';

const LEDGER_DIR = 'concord';

function loadChain(): ConcordEntry[] {
  if (!existsSync(LEDGER_DIR)) return [];
  return readdirSync(LEDGER_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(LEDGER_DIR, f), 'utf8')) as ConcordEntry)
    .sort((a, b) => a.mr_iid - b.mr_iid);
}

export function writeEntry(mr_iid: number, head_sha: string, rounds: Round[], verdict: Verdict): ConcordEntry {
  const chain = loadChain();
  const prev = chain.length ? chain[chain.length - 1] : null;
  const entry = linkEntry(prev, { mr_iid, head_sha, rounds, verdict, created_at: new Date().toISOString() });
  // Re-verify the whole chain INCLUDING the new entry before persisting (fail-closed).
  const check = verifyChain([...chain, entry]);
  if (!check.ok) throw new Error(`refusing to write: chain broken at ${check.brokenAt}: ${check.reason}`);
  writeFileSync(join(LEDGER_DIR, `${mr_iid}.json`), JSON.stringify(entry, null, 2) + '\n');
  return entry;
}
