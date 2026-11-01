/**
 * AQ-FND — G-8: same-address hardening, LIVE cross-chain (0G Galileo ⇄ Base Sepolia).
 *
 * The V6 same-address claim is that an account's CREATE2 preimage — the std proxy,
 * the five pinned singletons, and the initcode — is byte-identical on every chain,
 * so funds bridged to the agent's address on a far chain land on the SAME proven
 * wall. assertSameAddress enforces it; this probe PROVES its PASS-1 dependency
 * live: the three AQ-FND V6 singletons deploy to the SAME address with the SAME
 * codehash on a second chain (the deployer + SigningLib + DecodeLib were already
 * proven same-address by the V5 cross-chain work — verified here too).
 *
 * Deterministic via the 0x4e59 std proxy + the v2 salts (post-Gate-②-fix bytecode).
 * Idempotent: a singleton already at its address is left alone.
 *
 * Run:  cd /Users/MAC/leash/backend
 *       OPS=$(grep '^OPS_PRIVATE_KEY=' .env | cut -d= -f2-) npx tsx scripts/aq-fnd-g8-xchain-probe.mts --send
 *   (omit --send for a read-only parity check of whatever is already deployed.)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  createPublicClient, createWalletClient, http, keccak256, concat, getCreate2Address,
  type Address, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const OUT = '/Users/MAC/0g-fleet/docs/evidence/aq-fnd';
const SEND = process.argv.includes('--send');
const STD_PROXY = '0x4e59b44847b379578588920cA78FbF26c0B4956C' as Address;

const HOME = { id: 16602, name: '0G Galileo', rpc: 'https://evmrpc-testnet.0g.ai' };
const DESTS = {
  base: { id: 84532, name: 'Base Sepolia', rpc: 'https://base-sepolia.drpc.org' },
  eth: { id: 11155111, name: 'Ethereum Sepolia', rpc: 'https://ethereum-sepolia-rpc.publicnode.com' },
  arb: { id: 421614, name: 'Arbitrum Sepolia', rpc: 'https://sepolia-rollup.arbitrum.io/rpc' },
} as const;
const destKey = (process.argv.find((a) => a.startsWith('--dest='))?.slice(7) ?? 'base') as keyof typeof DESTS;
if (!DESTS[destKey]) throw new Error(`--dest must be one of ${Object.keys(DESTS).join('|')}`);
const DEST = DESTS[destKey];
const SUFFIX = destKey === 'base' ? '' : `-${destKey}`; // base keeps its original evidence filenames

const artifact = (rel: string): Hex =>
  JSON.parse(readFileSync(`/Users/MAC/leash/contracts/out/${rel}`, 'utf8')).bytecode.object as Hex;

const SINGLETONS = [
  { name: 'PolicyLib', creation: artifact('PolicyLib.sol/PolicyLib.json'), salt: 'leash.aqfnd.policylib.v2' },
  { name: 'EnvelopeModuleV6', creation: artifact('LeashEnvelopeModuleV6.sol/LeashEnvelopeModuleV6.json'), salt: 'leash.aqfnd.envmodule.v2' },
  { name: 'GasRepayDelegate', creation: artifact('GasRepayDelegate.sol/GasRepayDelegate.json'), salt: 'leash.aqfnd.gasdelegate.v2' },
];
// already-proven-same-address V5 infra (read-only parity re-check)
const EXISTING = [
  { name: 'Create2Deployer', addr: '0xCD1cdcDfBCB04873c26D168903595F0e93038B85' as Address },
  { name: 'SigningLib', addr: '0x46130314ad969Ac2153Bde1E73c6A36Bb65EB1AB' as Address },
  { name: 'DecodeLib', addr: '0x512A06eDdE20734f1F9521711bb48246d1f8D173' as Address },
];

const chain = (c: typeof HOME) => ({ id: c.id, name: c.name, nativeCurrency: { name: 'x', symbol: 'x', decimals: 18 }, rpcUrls: { default: { http: [c.rpc] } } });
const pub = (c: typeof HOME) => createPublicClient({ chain: chain(c), transport: http(c.rpc, { timeout: 30_000 }) });

type Row = { check: string; result: string; verdict: 'PASS' | 'FAIL' | 'INFO' };
const rows: Row[] = [];
const log = (r: Row) => { rows.push(r); console.log(`[${r.verdict.padEnd(4)}] ${r.check.padEnd(48)} ${r.result}`); };

const saltOf = (label: string): Hex => keccak256(`0x${Buffer.from(label).toString('hex')}` as Hex);
const predict = (creation: Hex, label: string): Address =>
  getCreate2Address({ from: STD_PROXY, salt: saltOf(label), bytecodeHash: keccak256(creation) });

async function codehash(c: typeof HOME, addr: Address): Promise<string | null> {
  const code = await pub(c).getCode({ address: addr });
  return code && code !== '0x' ? keccak256(code) : null;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const ops = SEND ? privateKeyToAccount(process.env.OPS as Hex) : null;
  const destWallet = ops ? createWalletClient({ account: ops, chain: chain(DEST), transport: http(DEST.rpc, { timeout: 60_000 }) }) : null;
  if (ops) console.log(`ops ${ops.address}, ${DEST.name} balance ${await pub(DEST).getBalance({ address: ops.address })} wei`);

  // 1) deploy the 3 V6 singletons on the DEST chain (idempotent), same salts → same addresses
  for (const s of SINGLETONS) {
    const addr = predict(s.creation, s.salt);
    const have = await codehash(DEST, addr);
    if (!have && SEND && destWallet && ops) {
      const hash = await destWallet.sendTransaction({ account: ops, chain: chain(DEST), to: STD_PROXY, data: concat([saltOf(s.salt), s.creation]) });
      await pub(DEST).waitForTransactionReceipt({ hash, timeout: 120_000 });
      console.log(`  ${s.name} deployed on ${DEST.name} → ${addr} (tx ${hash})`);
    } else if (!have) {
      log({ check: `${s.name} present on ${DEST.name}`, result: `NOT deployed @ ${addr} (run with --send)`, verdict: 'INFO' });
    }
  }

  // 2) byte-exact same-address + same-codehash across HOME and DEST for every singleton
  for (const s of [...SINGLETONS.map((x) => ({ name: x.name, addr: predict(x.creation, x.salt) })), ...EXISTING]) {
    const homeHash = await codehash(HOME, s.addr);
    const destHash = await codehash(DEST, s.addr);
    const same = homeHash !== null && homeHash === destHash;
    log({
      check: `${s.name} same-address + same-codehash`,
      result: `addr ${s.addr} · home ${homeHash?.slice(0, 14) ?? 'none'}… · dest ${destHash?.slice(0, 14) ?? 'none'}…`,
      verdict: same ? 'PASS' : homeHash === null || destHash === null ? 'INFO' : 'FAIL',
    });
  }

  const stamp = new Date().toISOString();
  writeFileSync(`${OUT}/g8-xchain-results${SUFFIX}.json`, JSON.stringify({ stamp, home: HOME.id, dest: DEST.id, send: SEND, rows }, null, 2));
  const md = [`# AQ-FND G-8 cross-chain same-address — ${stamp}`, '', `home ${HOME.name} (${HOME.id}) ⇄ dest ${DEST.name} (${DEST.id})`, '',
    '| check | result | verdict |', '|---|---|---|', ...rows.map((r) => `| ${r.check} | ${r.result} | **${r.verdict}** |`)].join('\n');
  writeFileSync(`${OUT}/g8-xchain-results${SUFFIX}.md`, md);
  const fails = rows.filter((r) => r.verdict === 'FAIL').length;
  console.log(`\n${rows.filter((r) => r.verdict === 'PASS').length} PASS · ${fails} FAIL · written → ${OUT}/g8-xchain-results${SUFFIX}.{json,md}`);
  process.exit(fails > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
