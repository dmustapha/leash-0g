/* eslint-disable @typescript-eslint/no-non-null-assertion -- one-shot operator script */
/**
 * AQ-FND M-3 inc-3b S4 — live CCTP proof SETUP (Arb Sepolia source → Base Sepolia home). Script-driven
 * (the cockpit cannot yet grant on a source chain: D3b-1). Owner == ops key for the keeper agent.
 *
 *   cd /Users/MAC/leash/backend
 *   export DATABASE_URL=postgres://postgres:postgres@localhost:5433/leash
 *   npx tsx scripts/aq-fnd-s4-setup.mts onboard --agent=<uuid>      # deploy the same-address account on Arb + fund it
 *   npx tsx scripts/aq-fnd-s4-setup.mts grants  --agent=<uuid>      # owner-signed rules/budget; waits out the 15-min timelocks
 */
import 'dotenv/config';
import pg from 'pg';
import { createPublicClient, createWalletClient, http, parseAbi, encodeAbiParameters, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadConfig, buildChainConfigs } from '../src/config.js';
import { ChainRegistry } from '../src/chain/registry.js';
import { getAgentById } from '../src/store/agents.js';
import { onboardAgentToChain } from '../src/chain/onboard.js';
import { buildCctpBurnCalls } from '../src/governed-call/index.js';

const ARB = 421614;
const ARB_RPC = 'https://sepolia-rollup.arbitrum.io/rpc';
const ARB_USDC = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d' as Address;
const BASE_DOMAIN = 6;
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
const stage = process.argv[2];
const agentId = arg('agent');
if (!agentId || !['onboard', 'grants'].includes(stage ?? '')) throw new Error('usage: onboard|grants --agent=<uuid>');

const cfg = loadConfig();
const ops = privateKeyToAccount(cfg.OPS_PRIVATE_KEY as Hex);
const chain = { id: ARB, name: 'Arbitrum Sepolia', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [ARB_RPC] } } } as const;
const pub = createPublicClient({ chain, transport: http(ARB_RPC) });
const wallet = createWalletClient({ account: ops, chain, transport: http(ARB_RPC) });
const pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
const agent = await getAgentById(pool, agentId);
if (!agent) throw new Error('agent not found');
const account = agent.accountAddr as Address;
if (agent.ownerAddr.toLowerCase() !== ops.address.toLowerCase()) throw new Error('ops key is not this agent\'s owner');
const send = async (p: Parameters<typeof wallet.writeContract>[0]) => {
  const h = await wallet.writeContract(p);
  const r = await pub.waitForTransactionReceipt({ hash: h });
  if (r.status !== 'success') throw new Error(`tx reverted ${h}`);
  console.log('  tx', h);
  return h;
};

async function onboard() {
  const registry = new ChainRegistry(buildChainConfigs(cfg), { opsPrivateKey: cfg.OPS_PRIVATE_KEY, guardianPrivateKey: cfg.GUARDIAN_PRIVATE_KEY });
  const res = await onboardAgentToChain({ pool, getChainOps: (id) => registry.getChainOps(id) as never }, agent!, ARB);
  console.log('onboard', JSON.stringify({ addr: res.deployment.accountAddr, createTx: res.deployment.createTx, adopted: res.adopted, already: res.alreadyOnboarded }));
  if (res.deployment.accountAddr.toLowerCase() !== account.toLowerCase()) throw new Error('same-address violated');
  const sk = agent!.sessionKeyAddr as Address;
  const skEth = await pub.getBalance({ address: sk });
  if (skEth < 2_000_000_000_000_000n) {
    console.log('fund session key with 0.003 ETH on Arb');
    const h = await wallet.sendTransaction({ to: sk, value: 3_000_000_000_000_000n });
    await pub.waitForTransactionReceipt({ hash: h });
  }
  const erc20 = parseAbi(['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
  if ((await pub.readContract({ address: ARB_USDC, abi: erc20, functionName: 'balanceOf', args: [account] })) < 5_000_000n) {
    console.log('fund account with 5 USDC on Arb');
    await send({ address: ARB_USDC, abi: erc20, functionName: 'transfer', args: [account, 5_000_000n], chain, account: ops });
  }
  console.log('account USDC', await pub.readContract({ address: ARB_USDC, abi: erc20, functionName: 'balanceOf', args: [account] }), 'sessionKey ETH', await pub.getBalance({ address: sk }));
}

const V6 = parseAbi([
  'function proposeCallRule(address,bytes4,uint8,address[],uint128,uint128,bytes32)',
  'function applyCallRule()',
  'function proposeGoverned(uint8,bytes)',
  'function applyGoverned(uint8,bytes)',
  'function pendingGovernedEta() view returns (uint64)',
  'function pendingGovernedKind() view returns (uint8)',
  'function pendingCallRule() view returns (address,bytes4,uint8,uint128,uint128,bytes32,uint64)',
  'function assetPolicy(address) view returns (bool,uint128,uint128,uint32)',
]);
const ZERO32 = ('0x' + '0'.repeat(64)) as Hex;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = async () => Number((await pub.getBlock()).timestamp);

async function grants() {
  const messenger = cfg.CCTP_TOKEN_MESSENGER_ADDR as Address;
  const calls = buildCctpBurnCalls({ self: account, tokenMessenger: messenger, burnToken: ARB_USDC, destinationDomain: BASE_DOMAIN, amount: 1_000_000n });
  const selApprove = calls.approve.data.slice(0, 10) as Hex;
  const selBurn = calls.burn.data.slice(0, 10) as Hex;
  console.log('selectors', { selApprove, selBurn });
  const budgetPayload = encodeAbiParameters(
    [{ type: 'address' }, { type: 'tuple', components: [{ name: 'enabled', type: 'bool' }, { name: 'perTransferCap', type: 'uint128' }, { name: 'windowCap', type: 'uint128' }, { name: 'windowSeconds', type: 'uint32' }] }],
    [ARB_USDC, { enabled: true, perTransferCap: 50_000_000n, windowCap: 50_000_000n, windowSeconds: 86400 }],
  );
  const rules = [
    { name: 'USDC.approve(spender=messenger)', args: [ARB_USDC, selApprove, 0, [messenger], 5_000_000n, 20_000_000n, ZERO32] as const },
    { name: 'messenger.depositForBurn', args: [messenger, selBurn, 0, [], 5_000_000n, 20_000_000n, ZERO32] as const },
  ];
  const read = (fn: 'pendingGovernedEta') => pub.readContract({ address: account, abi: V6, functionName: fn });
  const budgetLive = async () => (await pub.readContract({ address: account, abi: V6, functionName: 'assetPolicy', args: [ARB_USDC] }))[0];
  // budget (governed slot) proposes right away, in parallel with rule 1 (separate slots)
  if (!(await budgetLive()) && (await read('pendingGovernedEta')) === 0n) { console.log('propose budget'); await send({ address: account, abi: V6, functionName: 'proposeGoverned', args: [1, budgetPayload], chain, account: ops }); }
  let ruleIdx = 0;
  const pendingRuleEta = async () => Number((await pub.readContract({ address: account, abi: V6, functionName: 'pendingCallRule' }))[6]);
  if ((await pendingRuleEta()) === 0) { console.log('propose rule 1:', rules[0]!.name); await send({ address: account, abi: V6, functionName: 'proposeCallRule', args: rules[0]!.args as never, chain, account: ops }); }
  for (;;) {
    const t = await now();
    const ge = Number(await read('pendingGovernedEta'));
    if (ge !== 0 && t >= ge) { console.log('apply budget'); await send({ address: account, abi: V6, functionName: 'applyGoverned', args: [1, budgetPayload], chain, account: ops }); }
    const re = await pendingRuleEta();
    if (re !== 0 && t >= re) {
      console.log('apply rule', ruleIdx + 1);
      await send({ address: account, abi: V6, functionName: 'applyCallRule', chain, account: ops });
      ruleIdx += 1;
      if (ruleIdx < rules.length) { console.log('propose rule', ruleIdx + 1, rules[ruleIdx]!.name); await send({ address: account, abi: V6, functionName: 'proposeCallRule', args: rules[ruleIdx]!.args as never, chain, account: ops }); }
    }
    if (ruleIdx >= rules.length && (await budgetLive())) break;
    console.log(`waiting… chain t=${t} budgetEta=${ge} ruleEta=${re} applied=${ruleIdx}/${rules.length}`);
    await sleep(30_000);
  }
  console.log('GRANTS DONE; assetPolicy(USDC)=', await pub.readContract({ address: account, abi: V6, functionName: 'assetPolicy', args: [ARB_USDC] }));
}

try { await (stage === 'onboard' ? onboard() : grants()); } finally { await pool.end(); }
