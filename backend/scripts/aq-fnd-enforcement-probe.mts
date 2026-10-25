/**
 * AQ-FND — P-ENF-1: on-chain enforcement probe (G-1…G-10).
 *
 * The instrument that asserts the ACCOUNT CONTRACT — not the backend — closes each AQ-FND leak,
 * run against a live testnet LeashAccountV6 deploy (sibling of q2vis/b1 probes). Scaffolded at
 * STEP-0 per the kickoff; each gate's assertion is filled in as the v6 surface lands in ⑤.
 *
 * Gates (AQ-FND-SPEC.md §4 — the pass bars are the spec's, verbatim):
 *   G-1  cap-independence: config-time windowCap >= perTransferCap (NON-strict; == allowed)
 *   G-2  window burst: sliding counter blocks the 2× boundary double-spend on ALL 3 money paths
 *   G-3  token-unit caps bind with no oracle read; no cross-asset total claimed
 *   G-4  approve(spender, X) debits X against the asset windowCap; cap-exhausted cannot approve
 *   G-5  bare-target governed call refused; only (target, selector) passes
 *   G-6  self-extension outside the owner envelope refused on-chain; inside passes instantly
 *   G-7  revoke/tighten instant; widen timelocked; timelockDelay cannot be instantly shortened
 *   G-8  assertSameAddress rejects init-code-hash mismatch + undeployed/mis-delegated destination
 *   G-9  bridge per-tx/per-day caps bind; no-fill → refund→retry; no un-prefunded route enterable
 *   G-10 v6 create surfaces audit-key signing degradation PRE-commitment (no silent fallback)
 *
 * Run (once a v6 testnet deploy exists):
 *   cd /Users/MAC/leash/backend
 *   OPS=$(grep '^OPS_PRIVATE_KEY=' .env | cut -d= -f2-) \
 *     npx tsx scripts/aq-fnd-enforcement-probe.mts --account=0x... --factory=0x...
 */
import { writeFileSync, mkdirSync } from 'node:fs';

const OUT = '/Users/MAC/0g-fleet/docs/evidence/aq-fnd';

const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

interface GateResult {
  gate: string;
  title: string;
  status: 'PASS' | 'FAIL' | 'NOT-RUN';
  evidence: string;
}

const GATES: Array<{ gate: string; title: string; run: () => Promise<GateResult> }> = [
  { gate: 'G-1', title: 'cap-independence (NON-strict, == allowed)', run: async () => notRun('G-1', 'cap-independence (NON-strict, == allowed)') },
  { gate: 'G-2', title: 'sliding-window boundary burst, all 3 money paths', run: async () => notRun('G-2', 'sliding-window boundary burst, all 3 money paths') },
  { gate: 'G-3', title: 'token-unit caps, no oracle', run: async () => notRun('G-3', 'token-unit caps, no oracle') },
  { gate: 'G-4', title: 'approve counted against windowCap', run: async () => notRun('G-4', 'approve counted against windowCap') },
  { gate: 'G-5', title: '(target, selector) never bare target', run: async () => notRun('G-5', '(target, selector) never bare target') },
  { gate: 'G-6', title: 'envelope attenuation both directions', run: async () => notRun('G-6', 'envelope attenuation both directions') },
  { gate: 'G-7', title: 'instant tighten / timelocked widen / self-governing delay', run: async () => notRun('G-7', 'instant tighten / timelocked widen / self-governing delay') },
  { gate: 'G-8', title: 'same-address hardening', run: async () => notRun('G-8', 'same-address hardening') },
  { gate: 'G-9', title: 'bridge blast-radius caps + recovery + gas-prefund', run: async () => notRun('G-9', 'bridge blast-radius caps + recovery + gas-prefund') },
  { gate: 'G-10', title: 'no silent signing degradation on v6 create', run: async () => notRun('G-10', 'no silent signing degradation on v6 create') },
];

function notRun(gate: string, title: string): GateResult {
  return { gate, title, status: 'NOT-RUN', evidence: 'scaffold — assertion lands with the v6 surface (⑤ build)' };
}

async function main() {
  const account = arg('account');
  const factory = arg('factory');
  if (!account || !factory) {
    console.log('P-ENF-1 scaffold: no --account/--factory given — emitting the gate register only.');
  }
  const results: GateResult[] = [];
  for (const g of GATES) results.push(await g.run());

  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/enforcement-probe-results.json`, JSON.stringify({ stamp: new Date().toISOString(), account, factory, results }, null, 2));
  for (const r of results) console.log(`[${r.status.padEnd(7)}] ${r.gate.padEnd(5)} ${r.title} — ${r.evidence}`);
  const failed = results.filter((r) => r.status === 'FAIL').length;
  const notRunN = results.filter((r) => r.status === 'NOT-RUN').length;
  console.log(`\n${results.length - failed - notRunN} PASS · ${failed} FAIL · ${notRunN} NOT-RUN`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
