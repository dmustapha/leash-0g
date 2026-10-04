// B2 (HACKATHON-RH2) — D2 scripted same-address assertion. Proves that the live
// cockpit's "onboard to Robinhood Chain" product moment lands an existing agent
// at its SAME address on RH, now that RH carries the PROD-bytecode factory
// (0x9C10…E46f, B1). Mechanism = the exact backend wire the Networks panel calls:
//   predictAccountV4 (refusal-first gate) → deployAndRegister (replay the tuple).
//
// We take a representative construction tuple (guardian = the backend guardian
// lane, as every real agent's is) and show:
//   D2a  predictAccountV4(RH prod factory) == predictAccountV4(Base Sepolia prod
//        factory) for the IDENTICAL tuple — same address cross-chain, by CREATE2.
//   D2b  replay-onboard on RH (deployAndRegister) mints AT that prediction;
//        getCode(RH) non-empty — the account is live on RH at the same address.
//   D2c  idempotent re-predict is stable; a MUTATED tuple (expiry+1) predicts a
//        DIFFERENT address — the refusal-first discriminator the gate relies on.
//
// The UI run against a real DB agent (Networks panel, Privy owner) is recorded as
// demo evidence ON TOP of this machine proof.
//
// Run: cd backend && npx tsx scripts/rh-onboard-sameaddr-d2.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { getAddress, keccak256, stringToHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { LeashChainOps } from '../src/chain/ops.js';

const env: Record<string, string> = {};
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const t = line.trim();
  if (t && !t.startsWith('#') && t.includes('=')) {
    const i = t.indexOf('=');
    env[t.slice(0, i)] = t.slice(i + 1).replace(/^"|"$/g, '');
  }
}
function req(n: string): string { const v = env[n]; if (!v) throw new Error(`requires ${n}`); return v; }

const PROD_FACTORY = getAddress('0x9C10b48748Da1cA0CEE5AD7DA0725490A7d5E46f');
const RH_REGISTRY = getAddress('0xf2943580DABc1dd5eD417a5DC58D35110640BB2f');
const RELAY = 'http://127.0.0.1:8899';
const E18 = 10n ** 18n;

const ops = privateKeyToAccount(req('OPS_PRIVATE_KEY') as Hex);
const guardian = privateKeyToAccount(req('GUARDIAN_PRIVATE_KEY') as Hex);

// A representative existing-agent construction tuple. guardian == the backend
// guardian lane (true of every real agent) so the prediction is reproducible on
// any chain carrying the prod factory. Deterministic salt → stable addresses.
const tuple = {
  ownerAddr: ops.address,
  sessionKeyAddr: ops.address,
  guardianAddr: guardian.address,
  policy: { perTransferCap: E18, windowCap: 10n * E18, windowSeconds: 3600, expiresAt: 2 ** 31 },
  allowlist: [] as string[],
  timelockDelay: 0,
  settlementToken: '0x5F6a3AbC97E421f7B3930fc504D6a0CE4eE41e06',
  tokenPolicy: { perTransferCapToken: 1000n * E18, windowCapToken: 5000n * E18 },
  accountSalt: keccak256(stringToHex('RH2-D2-SAMEADDR-PROOF')) as string,
};

const rh = new LeashChainOps({
  rpcUrl: RELAY, chainId: 46630, opsPrivateKey: req('OPS_PRIVATE_KEY'), guardianPrivateKey: req('GUARDIAN_PRIVATE_KEY'),
  factoryV4Addr: PROD_FACTORY, registryAddr: RH_REGISTRY,
});
const base = new LeashChainOps({
  rpcUrl: req('BASE_SEPOLIA_RPC'), chainId: 84532, opsPrivateKey: req('OPS_PRIVATE_KEY'), guardianPrivateKey: req('GUARDIAN_PRIVATE_KEY'),
  factoryV4Addr: PROD_FACTORY, registryAddr: RH_REGISTRY, // registry unused by predictAccountV4
});

const checks: Array<{ check: string; ok: boolean; detail: string }> = [];
function rec(check: string, ok: boolean, detail: string) {
  checks.push({ check, ok, detail });
  console.log(`${ok ? 'pass' : 'FAIL'}  ${check} — ${detail}`);
}

async function main() {
  console.log(`D2 same-address · RH 46630 (prod factory ${PROD_FACTORY}) vs Base 84532 · owner ${ops.address}`);

  // D2a — cross-chain identical prediction
  const pRH = (await rh.predictAccountV4(tuple)).toLowerCase();
  const pBase = (await base.predictAccountV4(tuple)).toLowerCase();
  rec('D2a cross-chain prediction identical (RH == Base, prod factory)', pRH === pBase, `RH=${pRH} Base=${pBase}`);

  // D2b — replay-onboard on RH lands AT the prediction, account live on RH
  let minted = '';
  const pre = await rh.getCodeHash(pRH);
  if (pre) {
    minted = pRH;
    rec('D2b account already present on RH at prediction (idempotent)', true, `codehash ${pre} at ${pRH}`);
  } else {
    const deployed = await rh.deployAndRegister({
      ownerAddr: tuple.ownerAddr, sessionKeyAddr: tuple.sessionKeyAddr, auditPubKey: '04' + 'ab'.repeat(64),
      name: `rh2-d2-${tuple.accountSalt.slice(0, 10)}`, accountVersion: 4, policy: tuple.policy,
      allowlist: tuple.allowlist, timelockDelay: tuple.timelockDelay, settlementToken: tuple.settlementToken,
      tokenPolicy: tuple.tokenPolicy, accountSalt: tuple.accountSalt,
    });
    minted = deployed.accountAddr.toLowerCase();
    const ch = await rh.getCodeHash(minted);
    rec('D2b replay-onboard mints AT prediction on RH', minted === pRH && !!ch,
      `minted=${minted} prediction=${pRH} createTx=${deployed.createTx} codehash=${ch}`);
  }

  // D2c — mutated tuple predicts a DIFFERENT address (the gate's discriminator)
  const mutated = { ...tuple, policy: { ...tuple.policy, expiresAt: tuple.policy.expiresAt + 1 } };
  const pMut = (await rh.predictAccountV4(mutated)).toLowerCase();
  rec('D2c mutated tuple (expiry+1) predicts a DIFFERENT address → refusal-first gate fires', pMut !== pRH, `mutated=${pMut} != ${pRH}`);

  const pass = checks.filter((c) => c.ok).length;
  const evidence = {
    drill: 'B2 — same-address onboard replay on RH prod factory (HACKATHON-RH2 D2)',
    rhChainId: 46630, homeCompareChainId: 84532, prodFactory: PROD_FACTORY,
    tupleSalt: tuple.accountSalt, predictedAddr: pRH, mintedAddr: minted,
    score: `${pass}/${checks.length}`, checks, at: new Date().toISOString(),
  };
  writeFileSync(new URL('../../docs/evidence/rh-onboard-sameaddr-d2.json', import.meta.url), JSON.stringify(evidence, null, 2));
  console.log(`\n${pass}/${checks.length} passed · evidence → docs/evidence/rh-onboard-sameaddr-d2.json`);
  if (pass < checks.length) process.exit(1);
}

main().catch((e) => { console.error('D2 error:', e); process.exit(1); });
