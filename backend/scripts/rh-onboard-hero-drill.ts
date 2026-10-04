// RH slice (Arbitrum Open House) drill — a PRODUCTION-PATH-created V4 agent on
// Robinhood Chain testnet (46630) trades a tokenized stock through the governed
// wall, and the oracle-aware price band reverts a premium trade and a stale feed.
// Proves the FULL onboard+govern+hero wire on RH via LeashChainOps.deployAndRegister
// (the exact code the cockpit's POST /api/agents runs), with NO server/DB/Privy.
//
// Run: cd backend && npx tsx scripts/rh-onboard-hero-drill.ts
// Reads backend/.env (OPS_PRIVATE_KEY, GUARDIAN_PRIVATE_KEY). RPC is the local
// relay (contracts/rpc-relay.cjs on :8899) to dodge forge/viem TLS BadRecordMac.
import { readFileSync, writeFileSync } from 'node:fs';
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  toFunctionSelector,
  getAddress,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { LeashChainOps } from '../src/chain/ops.js';
import { leashAccountV4Abi } from '../src/chain/abis.js';

const env: Record<string, string> = {};
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const t = line.trim();
  if (t && !t.startsWith('#') && t.includes('=')) {
    const i = t.indexOf('=');
    env[t.slice(0, i)] = t.slice(i + 1).replace(/^"|"$/g, '');
  }
}

const RPC = 'http://127.0.0.1:8899'; // relay → RH testnet
const CHAIN_ID = 46630;
const V4_FACTORY = getAddress('0x85E1758d29D2F5026E8B36664E41c6C891D0fF70'); // deterministic (audit-fixed wall)
const REGISTRY = getAddress('0xf2943580DABc1dd5eD417a5DC58D35110640BB2f');
const SUSD = getAddress('0x5F6a3AbC97E421f7B3930fc504D6a0CE4eE41e06'); // 18dp quote
const STSLA = getAddress('0xB9431b3be9a56a1eeA8E728326332f8B4dD51382'); // 18dp stock (priced asset)
const ROUTER = getAddress('0x4964991514f731CB3CF252108dFF889d30036fcb');
const FEED = getAddress('0x8E107bAC6f430aecB8Aa11B383E9690e9a5214bE'); // 8dp, TSLA=$100
const APPROVE_SEL = toFunctionSelector('approve(address,uint256)');
const SWAP_SEL = toFunctionSelector('swap(address,address,uint256,uint256,address,uint256)');

const E18 = 10n ** 18n;
const DL = 99999999999n;

const ops = privateKeyToAccount(env.OPS_PRIVATE_KEY as Hex);
const pub = createPublicClient({ transport: http(RPC) });
const wallet = createWalletClient({ account: ops, transport: http(RPC) });

// inline ABI fragments for things not in the backend ABI / mocks
const approveFrag = [{ name: 'approve', type: 'function', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' }] as const;
const swapFrag = [{ name: 'swap', type: 'function', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'uint256' }], stateMutability: 'nonpayable' }] as const;
const mintFrag = [{ name: 'mint', type: 'function', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' }] as const;
const setStaleFrag = [{ name: 'setStale', type: 'function', inputs: [{ type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' }] as const;
const setAnswerFrag = [{ name: 'setAnswer', type: 'function', inputs: [{ type: 'int256' }], outputs: [], stateMutability: 'nonpayable' }] as const;
const tightenBandFrag = [{ name: 'tightenPriceBand', type: 'function', inputs: [{ type: 'address' }, { type: 'bytes4' }, { type: 'address' }, { type: 'address' }, { type: 'uint32' }, { type: 'uint64' }], outputs: [], stateMutability: 'nonpayable' }] as const;
const balanceFrag = [{ name: 'balanceOf', type: 'function', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }] as const;

let pass = 0, fail = 0;
const results: Array<{ check: string; ok: boolean; detail: string }> = [];
function record(check: string, ok: boolean, detail: string) {
  results.push({ check, ok, detail });
  if (ok) { pass++; console.log(`pass  ${check} — ${detail}`); }
  else { fail++; console.log(`FAIL  ${check} — ${detail}`); }
}

async function send(to: Hex, data: Hex, gas = 500_000n): Promise<Hex> {
  const hash = await wallet.sendTransaction({ chain: null, to, data, gas });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}
let RECIPIENT: Hex = '0x0000000000000000000000000000000000000000';
function swapData(amountIn: bigint, minOut: bigint, tokenIn = SUSD, tokenOut = STSLA) {
  return encodeFunctionData({ abi: swapFrag, functionName: 'swap', args: [tokenIn, tokenOut, amountIn, minOut, RECIPIENT, DL] });
}
async function expectRevert(account: Hex, data: Hex): Promise<string> {
  try { await pub.call({ account: ops.address, to: account, data }); return ''; }
  catch (e) { return String((e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message); }
}

async function main() {
  console.log(`RH onboard+hero drill · chain ${CHAIN_ID} · det factory ${V4_FACTORY} · ops ${ops.address}`);

  // (1) PRODUCTION ONBOARD WIRE: mint a fresh RH-home V4 agent through the exact
  // backend code path (deployAndRegister, accountVersion 4, deterministic factory).
  const chain = new LeashChainOps({
    rpcUrl: RPC,
    chainId: CHAIN_ID,
    opsPrivateKey: env.OPS_PRIVATE_KEY,
    guardianPrivateKey: env.GUARDIAN_PRIVATE_KEY,
    factoryAddr: env.LEASH_FACTORY_ADDR,
    factoryV4Addr: V4_FACTORY,
    registryAddr: REGISTRY,
  });
  const deployed = await chain.deployAndRegister({
    ownerAddr: ops.address,
    sessionKeyAddr: ops.address,
    auditPubKey: '04' + 'ab'.repeat(64),
    name: `rh-hero-${Date.now()}`,
    accountVersion: 4,
    policy: { perTransferCap: E18, windowCap: 10n * E18, windowSeconds: 3600, expiresAt: 2 ** 31 },
    allowlist: [],
    timelockDelay: 0,
    settlementToken: SUSD,
    tokenPolicy: { perTransferCapToken: 1000n * E18, windowCapToken: 5000n * E18 },
  });
  const account = getAddress(deployed.accountAddr);
  RECIPIENT = account; // the agent receives the bought stock
  record('production onboard → RH-home V4 agent', deployed.accountVersion === 4, `account=${account} chainAgentId=${deployed.chainAgentId} createTx=${deployed.createTx}`);

  // Setup: fund the agent with sUSD; grant approve(router) + budget, swap(router)
  // rule, and the 5% price band (tighten = instant); then the agent approves router.
  await send(SUSD, encodeFunctionData({ abi: mintFrag, functionName: 'mint', args: [account, 10_000n * E18] }));
  await send(account, encodeFunctionData({ abi: leashAccountV4Abi, functionName: 'proposeSpendBudget', args: [SUSD, 5000n * E18] }));
  await send(account, encodeFunctionData({ abi: leashAccountV4Abi, functionName: 'applySpendBudget', args: [] }));
  await send(account, encodeFunctionData({ abi: leashAccountV4Abi, functionName: 'proposeCallRule', args: [SUSD, APPROVE_SEL, 0, [ROUTER], 2000n * E18, 5000n * E18, ('0x' + '00'.repeat(32)) as Hex] }));
  await send(account, encodeFunctionData({ abi: leashAccountV4Abi, functionName: 'applyCallRule', args: [] }));
  await send(account, encodeFunctionData({ abi: leashAccountV4Abi, functionName: 'proposeCallRule', args: [ROUTER, SWAP_SEL, 0, [], (2n ** 128n - 1n), (2n ** 128n - 1n), ('0x' + '00'.repeat(32)) as Hex] }));
  await send(account, encodeFunctionData({ abi: leashAccountV4Abi, functionName: 'applyCallRule', args: [] }));
  await send(account, encodeFunctionData({ abi: tightenBandFrag, functionName: 'tightenPriceBand', args: [ROUTER, SWAP_SEL, FEED, STSLA, 500, 3600n] }));
  // H-1 fix: latch default-deny pricing — any unbanded swap rule now reverts BandRequired.
  await send(account, encodeFunctionData({ abi: [{ name: 'enableRequireBandForSwap', type: 'function', inputs: [], outputs: [], stateMutability: 'nonpayable' }] as const, functionName: 'enableRequireBandForSwap', args: [] }));

  // (2) governed approve ACCEPTED (the enabling leg for the swap).
  const approveTx = await send(account, encodeFunctionData({ abi: leashAccountV4Abi, functionName: 'executeCall', args: [SUSD, 0n, encodeFunctionData({ abi: approveFrag, functionName: 'approve', args: [ROUTER, 2000n * E18] })] }));
  const allowance = (await pub.readContract({ address: SUSD, abi: [{ name: 'allowance', type: 'function', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }], functionName: 'allowance', args: [account, ROUTER] })) as bigint;
  record('governed approve ACCEPTED', allowance === 2000n * E18, `allowance=${allowance} tx=${approveTx}`);

  // Refresh the feed to $100 NOW (a prior run may have left updatedAt stale).
  await send(FEED, encodeFunctionData({ abi: setAnswerFrag, functionName: 'setAnswer', args: [10_000_000_000n] }));
  // (3) AGENT TRADES SANELY: 100 sUSD → ≥1 sTSLA, implied $100 == oracle (in band).
  const greenTx = await send(account, encodeFunctionData({ abi: leashAccountV4Abi, functionName: 'executeCall', args: [ROUTER, 0n, swapData(100n * E18, 1n * E18)] }));
  const bal = (await pub.readContract({ address: STSLA, abi: balanceFrag, functionName: 'balanceOf', args: [account] })) as bigint;
  record('agent trades sanely — in-band swap ACCEPTED', bal === 100n * E18, `sTSLA=${bal} tx=${greenTx}`);

  // (4) HERO: premium swap — 130 sUSD → 1 sTSLA, implied $130 > $105 band → PremiumBreach.
  const premMsg = await expectRevert(account, encodeFunctionData({ abi: leashAccountV4Abi, functionName: 'executeCall', args: [ROUTER, 0n, swapData(130n * E18, 1n * E18)] }));
  record('premium trade BLOCKED (PremiumBreach)', /b9947793|revert/i.test(premMsg), premMsg.slice(0, 120) || 'no revert');

  // (5) FAIL-CLOSED: make the feed stale, an in-band-priced swap reverts StaleOracle.
  await send(FEED, encodeFunctionData({ abi: setStaleFrag, functionName: 'setStale', args: [7200n] }));
  const staleMsg = await expectRevert(account, encodeFunctionData({ abi: leashAccountV4Abi, functionName: 'executeCall', args: [ROUTER, 0n, swapData(100n * E18, 1n * E18)] }));
  record('stale feed → trade BLOCKED (StaleOracle, fail-closed)', /4f725aba|revert/i.test(staleMsg), staleMsg.slice(0, 120) || 'no revert');
  await send(FEED, encodeFunctionData({ abi: setAnswerFrag, functionName: 'setAnswer', args: [10_000_000_000n] })); // restore $100

  const evidence = {
    drill: 'RH onboard + oracle-aware hero (Arbitrum Open House)',
    chainId: CHAIN_ID,
    factoryV4: V4_FACTORY,
    account,
    createTx: deployed.createTx,
    registerTx: deployed.registerTx,
    greenTx,
    score: `${pass}/${pass + fail}`,
    checks: results,
    at: new Date().toISOString(),
  };
  writeFileSync(new URL('../../docs/evidence/rh-onboard-hero-drill.json', import.meta.url), JSON.stringify(evidence, null, 2));
  console.log(`\n${pass}/${pass + fail} passed · evidence → docs/evidence/rh-onboard-hero-drill.json`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error('drill error:', e); process.exit(1); });
