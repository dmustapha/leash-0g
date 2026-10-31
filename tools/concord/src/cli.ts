#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { enforce } from './enforcer.js';
import { parseObjections } from './validate.js';
import { writeEntry } from './ledger.js';
import { verifyConcord, verifyChainCmd } from './verify-concord.js';
import type { Round, Verdict } from './types.js';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// Accept either an inline JSON string or a path to a JSON file.
function loadJson(input: string): unknown {
  if (existsSync(input)) return JSON.parse(readFileSync(input, 'utf8'));
  return JSON.parse(input);
}

async function main(): Promise<number> {
  const sub = process.argv[2];

  switch (sub) {
    case 'enforce': {
      const raw = arg('--objections');
      if (!raw) { console.error('usage: cli.js enforce --objections <json|file>'); return 2; }
      // Validate against objections.schema.json BEFORE the enforcer reads it. Malformed =>
      // fail-closed (parseObjections throws, caught below).
      const objections = parseObjections(loadJson(raw));
      const out = await enforce(objections);
      console.log(JSON.stringify(out, null, 2));
      return out.verdict === 'AGREE' ? 0 : 1;
    }

    case 'ledger': {
      const iid = Number(arg('--mr'));
      const verdictRaw = arg('--verdict');
      if (!iid || !verdictRaw) { console.error('usage: cli.js ledger --mr <iid> --verdict <json>'); return 2; }
      const payload = loadJson(verdictRaw) as { head_sha: string; rounds: Round[]; verdict: Verdict };
      const entry = writeEntry(iid, payload.head_sha, payload.rounds, payload.verdict);
      console.log(JSON.stringify(entry, null, 2));
      return 0;
    }

    case 'verify': {
      const iid = Number(arg('--mr'));
      if (!iid) { console.error('usage: cli.js verify --mr <iid>'); return 2; }
      return verifyConcord(iid);
    }

    case 'verify-chain':
      return verifyChainCmd();

    default:
      console.error('usage: cli.js <enforce|ledger|verify|verify-chain> ...');
      return 2;
  }
}

main()
  .then(code => process.exit(code))
  .catch(err => {
    // Any uncaught error on the enforce/verify path fails closed (merge blocked).
    console.error(`FAIL-CLOSED: ${err?.message ?? err}`);
    process.exit(1);
  });
