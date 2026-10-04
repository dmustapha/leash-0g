// B4 (HACKATHON-RH2) — D5 capability-factory create wire. Proves the product path
// that stages the oracle-wall HERO as a first-class RH cockpit agent: the SAME
// ChainRegistry the owner API uses, resolving the NAMED `oracleBand` capability to
// the price-band wall factory, mints + configures a band hero on RH 46630.
//   D5a  getCapabilityFactory(46630,'oracleBand') == the band factory; a bogus
//        capability resolves to undefined (default-deny at the route → 409).
//   D5b  getChainOpsForFactory default-denies an OFF-CONFIG factory address (a
//        caller can never inject an arbitrary factory).
//   D5c  create via the band capability factory → a band-WALL agent (its address
//        differs from the prod factory's prediction for the same tuple — proof it
//        minted through the band wall, not the default wall).
//   D5d  the created hero, once its band is set, reports requireBandForSwap == true
//        on-chain — it IS the oracle-wall hero, readable by the cockpit detail view.
//   D5e  the DEFAULT create path (no capability) still uses the PROD factory.
//
// Run: cd backend && npx tsx scripts/rh-capability-hero-d5.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { createWalletClient, createPublicClient, http, encodeFunctionData, toFunctionSelector, getAddress, keccak256, stringToHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ChainRegistry, type ChainConfig } from '../src/chain/registry.js';

const env: Record<string, string> = {};
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const t = line.trim();
  if (t && !t.startsWith('#') && t.includes('=')) { const i = t.indexOf('='); env[t.slice(0, i)] = t.slice(i + 1).replace(/^"|"$/g, ''); }
}
function req(n: string): string { const v = env[n]; if (!v) throw new Error(`requires ${n}`); return v; }

const RELAY = 'http://127.0.0.1:8899';
const PROD = '0x9C10b48748Da1cA0CEE5AD7DA0725490A7d5E46f';
const BAND = '0x85E1758d29D2F5026E8B36664E41c6C891D0fF70';
const RH_REGISTRY = '0xf2943580DABc1dd5eD417a5DC58D35110640BB2f';
const SUSD = getAddress('0x5F6a3AbC97E421f7B3930fc504D6a0CE4eE41e06');
const STSLA = getAddress('0xB9431b3be9a56a1eeA8E728326332f8B4dD51382');
const ROUTER = getAddress('0x4964991514f731CB3CF252108dFF889d30036fcb');
const FEED = getAddress('0x8E107bAC6f430aecB8Aa11B383E9690e9a5214bE');
const SWAP_SEL = toFunctionSelector('swap(address,address,uint256,uint256,address,uint256)');
const E18 = 10n ** 18n;

const ops = privateKeyToAccount(req('OPS_PRIVATE_KEY') as Hex);
const pub = createPublicClient({ transport: http(RELAY) });
const wallet = createWalletClient({ account: ops, transport: http(RELAY) });

// The RH chain config EXACTLY as the live backend builds it from EXTRA_CHAINS.
const rhConfig: ChainConfig = {
  chainId: 46630, name: 'Robinhood Chain testnet', rpcUrl: RELAY,
  factoryV4Addr: PROD, registryAddr: RH_REGISTRY, accountVersion: 4, gasFloorWei: 0n,
  capabilityFactories: { oracleBand: BAND },
};
const registry = new ChainRegistry([rhConfig], { opsPrivateKey: req('OPS_PRIVATE_KEY'), guardianPrivateKey: req('GUARDIAN_PRIVATE_KEY') });

const tightenBandFrag = [{ name: 'tightenPriceBand', type: 'function', inputs: [{ type: 'address' }, { type: 'bytes4' }, { type: 'address' }, { type: 'address' }, { type: 'uint32' }, { type: 'uint64' }], outputs: [], stateMutability: 'nonpayable' }] as const;
const enableFrag = [{ name: 'enableRequireBandForSwap', type: 'function', inputs: [], outputs: [], stateMutability: 'nonpayable' }] as const;
const requireBandFrag = [{ name: 'requireBandForSwap', type: 'function', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' }] as const;

const checks: Array<{ check: string; ok: boolean; detail: string }> = [];
function rec(check: string, ok: boolean, detail: string) { checks.push({ check, ok, detail }); console.log(`${ok ? 'pass' : 'FAIL'}  ${check} — ${detail}`); }
async function send(to: Hex, data: Hex, gas = 500_000n): Promise<Hex> { const h = await wallet.sendTransaction({ chain: null, to, data, gas }); await pub.waitForTransactionReceipt({ hash: h }); return h; }

async function main() {
  console.log(`D5 capability-factory hero · RH 46630 · default=${PROD} oracleBand=${BAND}`);

  // D5a — named capability resolves; bogus does not.
  const resolved = registry.getCapabilityFactory(46630, 'oracleBand');
  const bogus = registry.getCapabilityFactory(46630, 'nope');
  rec('D5a getCapabilityFactory resolves oracleBand, default-denies unknown', resolved?.toLowerCase() === BAND.toLowerCase() && bogus === undefined, `oracleBand=${resolved} bogus=${bogus}`);

  // D5b — off-config factory address is refused (no arbitrary-factory injection).
  let denied = false;
  try { registry.getChainOpsForFactory(46630, '0x000000000000000000000000000000000000dEaD'); }
  catch { denied = true; }
  rec('D5b getChainOpsForFactory default-denies an off-config factory', denied, 'arbitrary factory rejected');

  // D5c — create via the band capability factory (the exact wire the route runs).
  const bandOps = registry.getChainOpsForFactory(46630, resolved!);
  const salt = keccak256(stringToHex(`RH2-D5-HERO-${Date.now()}`)) as string;
  const tuple = {
    ownerAddr: ops.address, sessionKeyAddr: ops.address, auditPubKey: '04' + 'ef'.repeat(64),
    name: 'rh2-d5-oracle-hero', accountVersion: 4 as const,
    policy: { perTransferCap: E18, windowCap: 10n * E18, windowSeconds: 3600, expiresAt: 2 ** 31 },
    allowlist: [] as string[], timelockDelay: 0, settlementToken: SUSD,
    tokenPolicy: { perTransferCapToken: 1000n * E18, windowCapToken: 5000n * E18 }, accountSalt: salt,
  };
  const hero = await bandOps.deployAndRegister(tuple);
  const account = getAddress(hero.accountAddr);
  // Same tuple predicted on the PROD factory would land elsewhere → proves it
  // minted through the BAND wall, not the default wall.
  const prodOps = registry.getChainOps(46630);
  const prodPrediction = (await prodOps.predictAccountV4({ ...tuple, guardianAddr: privateKeyToAccount(req('GUARDIAN_PRIVATE_KEY') as Hex).address })).toLowerCase();
  rec('D5c create via oracleBand factory mints a distinct (band-wall) account', account.toLowerCase() !== prodPrediction, `bandAccount=${account} prodPrediction=${prodPrediction} createTx=${hero.createTx}`);

  // D5d — configure the band + latch, then read requireBandForSwap on-chain.
  await send(account, encodeFunctionData({ abi: tightenBandFrag, functionName: 'tightenPriceBand', args: [ROUTER, SWAP_SEL, FEED, STSLA, 500, 3600n] }));
  await send(account, encodeFunctionData({ abi: enableFrag, functionName: 'enableRequireBandForSwap', args: [] }));
  const latched = (await pub.readContract({ address: account, abi: requireBandFrag, functionName: 'requireBandForSwap', args: [] })) as boolean;
  rec('D5d created hero reports requireBandForSwap == true on-chain (IS the oracle-wall hero)', latched === true, `account=${account} requireBandForSwap=${latched}`);

  // D5e — the DEFAULT lane still points at the PROD factory.
  const defaultLane = registry.getChainOpsForFactory(46630, PROD);
  rec('D5e default create lane uses the PROD factory', defaultLane === prodOps, 'default lane === getChainOps (prod factory)');

  const pass = checks.filter((c) => c.ok).length;
  const evidence = { drill: 'B4 — capability-factory create wire (HACKATHON-RH2 D5)', chainId: 46630, defaultFactory: PROD, oracleBandFactory: BAND, heroAccount: account, heroCreateTx: hero.createTx, score: `${pass}/${checks.length}`, checks, at: new Date().toISOString() };
  writeFileSync(new URL('../../docs/evidence/rh-capability-hero-d5.json', import.meta.url), JSON.stringify(evidence, null, 2));
  console.log(`\n${pass}/${checks.length} passed · evidence → docs/evidence/rh-capability-hero-d5.json`);
  if (pass < checks.length) process.exit(1);
}
main().catch((e) => { console.error('D5 error:', e); process.exit(1); });
