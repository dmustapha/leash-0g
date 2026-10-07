// B4 (HACKATHON-RH2) — D4 hero-staging, the on-chain-verifiable half. The oracle
// price-band HERO runs on the NEW-WALL factory agent (0x8979…F7A4). This asserts
// the band latch is ON on-chain (requireBandForSwap == true) and the headless
// hero drill stands at 5/5. The cockpit "visible in fleet + detail loads" half is
// an owner-authed POST /api/agents from Dami's browser session (see RESULTS: the
// which-factory decision gates it) — recorded as demo evidence on top.
//
// Run: cd backend && npx tsx scripts/rh-hero-staging-d4.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, http, getAddress } from 'viem';

const RELAY = 'http://127.0.0.1:8899';
const HERO = getAddress('0x8979C4c4291441cE51837a3be86f3443ea51F7A4'); // new-wall, band-latched
const pub = createPublicClient({ transport: http(RELAY) });
const requireBandFrag = [{ name: 'requireBandForSwap', type: 'function', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' }] as const;

const checks: Array<{ check: string; ok: boolean; detail: string }> = [];
function rec(check: string, ok: boolean, detail: string) { checks.push({ check, ok, detail }); console.log(`${ok ? 'pass' : 'FAIL'}  ${check} — ${detail}`); }

async function main() {
  const latched = (await pub.readContract({ address: HERO, abi: requireBandFrag, functionName: 'requireBandForSwap', args: [] })) as boolean;
  rec('D4 band latch ON on-chain (requireBandForSwap == true)', latched === true, `hero=${HERO} requireBandForSwap=${latched}`);

  const drill = JSON.parse(readFileSync(new URL('../../docs/evidence/rh-onboard-hero-drill.json', import.meta.url), 'utf8')) as { score: string; account: string };
  rec('D4 headless hero drill 5/5 (onboard→approve→in-band→PremiumBreach→StaleOracle)', drill.score === '5/5', `score=${drill.score} account=${drill.account}`);

  const pass = checks.filter((c) => c.ok).length;
  const evidence = {
    drill: 'B4 — hero staging, on-chain-verifiable half (HACKATHON-RH2 D4)',
    chainId: 46630, hero: HERO, bandLatchOn: checks[0].ok, heroDrillScore: (drill as { score: string }).score,
    fleetVisibility: 'PENDING-DAMI: owner-authed POST /api/agents from the live cockpit (see RESULTS — which-factory decision)',
    score: `${pass}/${checks.length}`, checks, at: new Date().toISOString(),
  };
  writeFileSync(new URL('../../docs/evidence/rh-hero-staging-d4.json', import.meta.url), JSON.stringify(evidence, null, 2));
  console.log(`\n${pass}/${checks.length} passed · evidence → docs/evidence/rh-hero-staging-d4.json`);
  if (pass < checks.length) process.exit(1);
}
main().catch((e) => { console.error('D4 error:', e); process.exit(1); });
