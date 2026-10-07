// B3 (HACKATHON-RH2) — D3 owner-op matrix vs the RH presence, scripted via the
// backend wire. On the PROD-factory RH agent (the one the cockpit onboards to,
// 0x9C10…E46f wall) we prove the owner/guardian control surface holds on RH:
//   D3a  POLICY — a governed call rule (approve(sUSD→router)) executes within cap.
//   D3b  REVOKE (one move) — guardian revoke() → revoked()==true → the SAME
//        governed call now reverts AccountRevoked (agent cut off instantly).
//   D3c  REARM — owner rearm() → revoked()==false → the governed call works again.
//   D3d  AUDIT LINK — every tx resolves on RH Blockscout (prefix = web/lib/networks.ts
//        [46630]); the receipt exists and the explorer URL is well-formed.
//
// The live cockpit UI pass (revoke button, policy panel, audit rows) is logged as
// demo evidence ON TOP of this machine proof (needs Dami's Privy owner session).
//
// Run: cd backend && npx tsx scripts/rh-owner-ops-d3.ts
import { readFileSync, writeFileSync } from 'node:fs';
import {
  createPublicClient, createWalletClient, http, encodeFunctionData, getAddress,
  keccak256, stringToHex, toFunctionSelector, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { LeashChainOps } from '../src/chain/ops.js';
import { leashAccountV4Abi } from '../src/chain/abis.js';

const env: Record<string, string> = {};
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const t = line.trim();
  if (t && !t.startsWith('#') && t.includes('=')) { const i = t.indexOf('='); env[t.slice(0, i)] = t.slice(i + 1).replace(/^"|"$/g, ''); }
}
function req(n: string): string { const v = env[n]; if (!v) throw new Error(`requires ${n}`); return v; }

const RELAY = 'http://127.0.0.1:8899';
const PROD_FACTORY = getAddress('0x9C10b48748Da1cA0CEE5AD7DA0725490A7d5E46f');
const RH_REGISTRY = getAddress('0xf2943580DABc1dd5eD417a5DC58D35110640BB2f');
const SUSD = getAddress('0x5F6a3AbC97E421f7B3930fc504D6a0CE4eE41e06');
const ROUTER = getAddress('0x4964991514f731CB3CF252108dFF889d30036fcb');
const BLOCKSCOUT_TX = 'https://explorer.testnet.chain.robinhood.com/tx/'; // == web/lib/networks.ts[46630]
const APPROVE_SEL = toFunctionSelector('approve(address,uint256)');
const E18 = 10n ** 18n;

const ops = privateKeyToAccount(req('OPS_PRIVATE_KEY') as Hex);
const pub = createPublicClient({ transport: http(RELAY) });
const wallet = createWalletClient({ account: ops, transport: http(RELAY) });

const approveFrag = [{ name: 'approve', type: 'function', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' }] as const;
const allowanceFrag = [{ name: 'allowance', type: 'function', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }] as const;
const revokedFrag = [{ name: 'revoked', type: 'function', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' }] as const;
const rearmFrag = [{ name: 'rearm', type: 'function', inputs: [], outputs: [], stateMutability: 'nonpayable' }] as const;

const checks: Array<{ check: string; ok: boolean; detail: string }> = [];
function rec(check: string, ok: boolean, detail: string) { checks.push({ check, ok, detail }); console.log(`${ok ? 'pass' : 'FAIL'}  ${check} — ${detail}`); }

async function send(to: Hex, data: Hex, gas = 500_000n): Promise<Hex> {
  const hash = await wallet.sendTransaction({ chain: null, to, data, gas });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}
async function callReverts(to: Hex, data: Hex): Promise<string> {
  try { await pub.call({ account: ops.address, to, data }); return ''; }
  catch (e) { return String((e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message); }
}
function approveCall(amount: bigint): Hex {
  return encodeFunctionData({ abi: leashAccountV4Abi, functionName: 'executeCall', args: [SUSD, 0n, encodeFunctionData({ abi: approveFrag, functionName: 'approve', args: [ROUTER, amount] })] });
}

async function main() {
  // Dedicated D3 agent on the PROD factory (distinct salt so it is reproducible/idempotent).
  const chain = new LeashChainOps({ rpcUrl: RELAY, chainId: 46630, opsPrivateKey: req('OPS_PRIVATE_KEY'), guardianPrivateKey: req('GUARDIAN_PRIVATE_KEY'), factoryV4Addr: PROD_FACTORY, registryAddr: RH_REGISTRY });
  // Fresh agent per run → clean windowed approve-budget (no cross-run exhaustion).
  const salt = keccak256(stringToHex(`RH2-D3-OWNER-OPS-${Date.now()}`)) as string;
  const deployed = await chain.deployAndRegister({
    ownerAddr: ops.address, sessionKeyAddr: ops.address, auditPubKey: '04' + 'cd'.repeat(64),
    name: 'rh2-d3-ownerops', accountVersion: 4,
    policy: { perTransferCap: E18, windowCap: 10n * E18, windowSeconds: 3600, expiresAt: 2 ** 31 },
    allowlist: [], timelockDelay: 0, settlementToken: SUSD,
    tokenPolicy: { perTransferCapToken: 1000n * E18, windowCapToken: 5000n * E18 }, accountSalt: salt,
  });
  const account = getAddress(deployed.accountAddr);
  console.log(`D3 owner-ops · RH 46630 · prod-factory agent ${account} (chainAgentId ${deployed.chainAgentId})`);

  // Grant: spend budget + approve(sUSD→router) call rule (this IS the policy
  // surface). Tolerant of an idempotent re-adopt (grants may already be applied).
  async function tryGrant(label: string, data: Hex) {
    try { await send(account, data); } catch (e) { console.log(`  (grant ${label} skipped: ${String((e as Error).message).slice(0, 60)})`); }
  }
  await tryGrant('proposeSpendBudget', encodeFunctionData({ abi: leashAccountV4Abi, functionName: 'proposeSpendBudget', args: [SUSD, 5000n * E18] }));
  await tryGrant('applySpendBudget', encodeFunctionData({ abi: leashAccountV4Abi, functionName: 'applySpendBudget', args: [] }));
  await tryGrant('proposeCallRule', encodeFunctionData({ abi: leashAccountV4Abi, functionName: 'proposeCallRule', args: [SUSD, APPROVE_SEL, 0, [ROUTER], 2000n * E18, 5000n * E18, ('0x' + '00'.repeat(32)) as Hex] }));
  await tryGrant('applyCallRule', encodeFunctionData({ abi: leashAccountV4Abi, functionName: 'applyCallRule', args: [] }));

  // D3a — governed call within cap executes.
  const approveTx = await send(account, approveCall(1000n * E18));
  const allowance = (await pub.readContract({ address: SUSD, abi: allowanceFrag, functionName: 'allowance', args: [account, ROUTER] })) as bigint;
  rec('D3a POLICY — governed approve(router) executes within cap', allowance === 1000n * E18, `allowance=${allowance} tx=${approveTx}`);

  // D3b — one-move revoke (owner lane; revoke() accepts owner OR guardian) →
  // agent cut off; the same governed call reverts AccountRevoked.
  const revokeTx = await send(account, encodeFunctionData({ abi: [{ name: 'revoke', type: 'function', inputs: [], outputs: [], stateMutability: 'nonpayable' }] as const, functionName: 'revoke', args: [] }));
  const revokedOn = (await pub.readContract({ address: account, abi: revokedFrag, functionName: 'revoked', args: [] })) as boolean;
  const revMsg = await callReverts(account, approveCall(500n * E18));
  rec('D3b REVOKE (one move) — revoked()==true & governed call reverts AccountRevoked', revokedOn && /AccountRevoked|revert/i.test(revMsg), `revoked=${revokedOn} revertMsg="${revMsg.slice(0, 80)}" tx=${revokeTx}`);

  // D3c — owner rearm → agent resumes; the governed call works again.
  const rearmTx = await send(account, encodeFunctionData({ abi: rearmFrag, functionName: 'rearm', args: [] }));
  const revokedOff = (await pub.readContract({ address: account, abi: revokedFrag, functionName: 'revoked', args: [] })) as boolean;
  const approve2Tx = await send(account, approveCall(1500n * E18));
  const allowance2 = (await pub.readContract({ address: SUSD, abi: allowanceFrag, functionName: 'allowance', args: [account, ROUTER] })) as bigint;
  rec('D3c REARM — revoked()==false & governed call works again', !revokedOff && allowance2 === 1500n * E18, `revoked=${revokedOff} allowance=${allowance2} rearmTx=${rearmTx} approveTx=${approve2Tx}`);

  // D3d — audit links resolve on RH Blockscout (receipt exists + URL well-formed).
  const links: Record<string, string> = {};
  let allResolve = true;
  const ZERO = '0x' + '00'.repeat(32);
  // createTx is absent on an idempotent adopt — audit the live-session txs that exist.
  const auditable: Record<string, string> = { approve: approveTx, revoke: revokeTx, rearm: rearmTx };
  if (deployed.createTx && deployed.createTx !== ZERO) auditable.create = deployed.createTx;
  for (const [label, tx] of Object.entries(auditable)) {
    const r = await pub.getTransactionReceipt({ hash: tx as Hex });
    const url = `${BLOCKSCOUT_TX}${tx}`;
    links[label] = url;
    if (!r || !url.startsWith('https://explorer.testnet.chain.robinhood.com/tx/0x')) allResolve = false;
  }
  rec('D3d AUDIT — every tx resolves on RH Blockscout (receipt + well-formed link)', allResolve, Object.values(links).join('  '));

  const pass = checks.filter((c) => c.ok).length;
  const evidence = { drill: 'B3 — owner-op matrix vs RH prod-factory presence (HACKATHON-RH2 D3)', chainId: 46630, account, prodFactory: PROD_FACTORY, blockscoutLinks: links, score: `${pass}/${checks.length}`, checks, at: new Date().toISOString() };
  writeFileSync(new URL('../../docs/evidence/rh-owner-ops-d3.json', import.meta.url), JSON.stringify(evidence, null, 2));
  console.log(`\n${pass}/${checks.length} passed · evidence → docs/evidence/rh-owner-ops-d3.json`);
  if (pass < checks.length) process.exit(1);
}
main().catch((e) => { console.error('D3 error:', e); process.exit(1); });
