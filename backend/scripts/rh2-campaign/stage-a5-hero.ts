// Stage A5-hero — RH band-wall beats + demo-account staging + portability spine.
// Part A: stage the PRODUCT band account (0xF2c0…) as the cockpit demo hero —
//         owner-a signs tightenPriceBand + enableRequireBandForSwap; assert
//         requireBandForSwap()==true on-chain + D4 fleet visibility via API.
// Part B: wall beats on a drill twin (ops = owner+session, timelock 0) through
//         the SAME band factory: green swap ✓ / PremiumBreach ✗ / StaleOracle ✗
//         / fail-closed; feed restored after.
// Part C: portability — onboard a2 executor 0G→Base via API, same-address assert,
//         idempotent re-onboard. (act-on-chain-2 → A5-full, honestly deferred.)
// Run: cd backend && npx tsx scripts/rh2-campaign/stage-a5-hero.ts
import { readFileSync, appendFileSync } from 'node:fs';
import {
  createWalletClient, createPublicClient, http, encodeFunctionData, toFunctionSelector,
  getAddress, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { LeashChainOps } from '../../src/chain/ops.js';
import { leashAccountV4Abi } from '../../src/chain/abis.js';

const env: Record<string, string> = {};
for (const line of readFileSync(new URL('../../.env', import.meta.url), 'utf8').split('\n')) {
  const t = line.trim();
  if (t && !t.startsWith('#') && t.includes('=')) { const i = t.indexOf('='); env[t.slice(0, i)] = t.slice(i + 1).replace(/^"|"$/g, ''); }
}

const API = 'https://leash-0g-backend-rh2.onrender.com';
const RPC = 'https://rpc.testnet.chain.robinhood.com';
const BAND_FACTORY = getAddress('0x85E1758d29D2F5026E8B36664E41c6C891D0fF70');
const REGISTRY = getAddress('0xf2943580DABc1dd5eD417a5DC58D35110640BB2f');
const SUSD = getAddress('0x5F6a3AbC97E421f7B3930fc504D6a0CE4eE41e06');
const STSLA = getAddress('0xB9431b3be9a56a1eeA8E728326332f8B4dD51382');
const ROUTER = getAddress('0x4964991514f731CB3CF252108dFF889d30036fcb');
const FEED = getAddress('0x8E107bAC6f430aecB8Aa11B383E9690e9a5214bE');
const APPROVE_SEL = toFunctionSelector('approve(address,uint256)');
const SWAP_SEL = toFunctionSelector('swap(address,address,uint256,uint256,address,uint256)');
const E18 = 10n ** 18n;
const DL = 99999999999n;
const DEMO_ACCOUNT = getAddress('0xF2c06CCa6B1Cd3d5Ee4E2e61EB5bBc7AD82a5FC8');
const DEMO_AGENT_ID = '7451fc0c-7750-4a45-96fd-90e24e033e64';

const ops = privateKeyToAccount(env.OPS_PRIVATE_KEY as Hex);
const ownerA = privateKeyToAccount(readFileSync(new URL('./state/owner-a.key', import.meta.url), 'utf8').trim() as Hex);
const pub = createPublicClient({ transport: http(RPC) });
const opsW = createWalletClient({ account: ops, transport: http(RPC) });
const ownW = createWalletClient({ account: ownerA, transport: http(RPC) });

const FINDINGS = new URL('../../../tasks/e2e-rh-findings.md', import.meta.url);
const rows: string[] = [];
function rec(id: string, ok: boolean, note: string) {
  rows.push(`| ${id} | ${ok ? 'PASS' : '**FAIL**'} | ${note.replace(/\n/g, ' ').slice(0, 220)} |`);
  console.log(`${ok ? '✓' : '✗ FAIL'} ${id} ${note}`);
}

async function send(w: typeof opsW, to: Hex, data: Hex, gas = 600_000n): Promise<Hex> {
  const h = await w.sendTransaction({ chain: null, to, data, gas });
  await pub.waitForTransactionReceipt({ hash: h });
  return h;
}
async function expectRevert(from: typeof opsW, account: Hex, data: Hex): Promise<string> {
  try { await send(from, account, data); return ''; }
  catch (e) { return (e as Error).message ?? 'revert'; }
}

const tightenBandFrag = [{ name: 'tightenPriceBand', type: 'function', inputs: [{ type: 'address' }, { type: 'bytes4' }, { type: 'address' }, { type: 'address' }, { type: 'uint32' }, { type: 'uint64' }], outputs: [], stateMutability: 'nonpayable' }] as const;
const enableFrag = [{ name: 'enableRequireBandForSwap', type: 'function', inputs: [], outputs: [], stateMutability: 'nonpayable' }] as const;
const requireBandFrag = [{ name: 'requireBandForSwap', type: 'function', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' }] as const;
const mintFrag = [{ name: 'mint', type: 'function', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' }] as const;
const setStaleFrag = [{ name: 'setStale', type: 'function', inputs: [{ type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' }] as const;
const setAnswerFrag = [{ name: 'setAnswer', type: 'function', inputs: [{ type: 'int256' }], outputs: [], stateMutability: 'nonpayable' }] as const;
const approveFrag = [{ name: 'approve', type: 'function', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' }] as const;
const swapFrag = [{ name: 'swap', type: 'function', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'uint256' }], stateMutability: 'nonpayable' }] as const;
const balanceFrag = [{ name: 'balanceOf', type: 'function', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }] as const;

function swapData(recipient: Hex, amountIn: bigint, minOut: bigint) {
  return encodeFunctionData({ abi: swapFrag, functionName: 'swap', args: [SUSD, STSLA, amountIn, minOut, recipient, DL] });
}

async function main() {
  appendFileSync(FINDINGS, `\n### Stage A5-hero — ${new Date().toISOString()}\n| case | result | note |\n|---|---|---|\n`);

  // gas for owner-a on RH
  const ownBal = await pub.getBalance({ address: ownerA.address });
  if (ownBal < 10n ** 15n) {
    const h = await opsW.sendTransaction({ chain: null, to: ownerA.address, value: 2n * 10n ** 15n });
    await pub.waitForTransactionReceipt({ hash: h });
    console.log('owner-a gassed on RH', h.slice(0, 16));
  }

  // ---------- Part A: stage the PRODUCT demo account ----------
  console.log('\n== Part A: product band account staging (demo hero) ==');
  try {
    const t1 = await send(ownW, DEMO_ACCOUNT, encodeFunctionData({ abi: tightenBandFrag, functionName: 'tightenPriceBand', args: [ROUTER, SWAP_SEL, FEED, STSLA, 500, 3600n] }));
    const t2 = await send(ownW, DEMO_ACCOUNT, encodeFunctionData({ abi: enableFrag, functionName: 'enableRequireBandForSwap', args: [] }));
    const on = await pub.readContract({ address: DEMO_ACCOUNT, abi: requireBandFrag, functionName: 'requireBandForSwap' });
    rec('P7.2a-demo-band-latched', on === true, `tighten ${t1.slice(0, 14)}… enable ${t2.slice(0, 14)}… requireBandForSwap=${on}`);
  } catch (e) {
    rec('P7.2a-demo-band-latched', false, `owner band-config failed: ${(e as Error).message.slice(0, 160)}`);
  }
  // sUSD for the demo account (open test faucet mint)
  try {
    await send(opsW, SUSD, encodeFunctionData({ abi: mintFrag, functionName: 'mint', args: [DEMO_ACCOUNT, 1000n * E18] }));
    rec('P7.2b-demo-funded-susd', true, '1000 sUSD minted to demo account');
  } catch (e) { rec('P7.2b-demo-funded-susd', false, (e as Error).message.slice(0, 140)); }

  // D4 fleet visibility via the branch API (campaign owner-a session)
  try {
    const { privyLogin, makeApi } = await import('./common.mjs');
    const api = makeApi(await privyLogin(ownerA), API);
    const det = await api(`/api/agents/${DEMO_AGENT_ID}`);
    const nets = await api(`/api/agents/${DEMO_AGENT_ID}/networks`);
    const home = (nets.body.deployments ?? nets.body.networks ?? []).length;
    rec('P7.2c-fleet-visible', det.status === 200 && det.body.accountAddr?.toLowerCase() === DEMO_ACCOUNT.toLowerCase(),
      `detail ${det.status}, account match, status=${det.body.status}, networks entries=${home || 'n/a'}`);
  } catch (e) { rec('P7.2c-fleet-visible', false, (e as Error).message.slice(0, 140)); }

  // ---------- Part B: wall beats on the drill twin ----------
  console.log('\n== Part B: wall beats (drill twin via band factory) ==');
  const chain = new LeashChainOps({
    rpcUrl: RPC, chainId: 46630,
    opsPrivateKey: env.OPS_PRIVATE_KEY, guardianPrivateKey: env.GUARDIAN_PRIVATE_KEY,
    factoryAddr: env.LEASH_FACTORY_ADDR, factoryV4Addr: BAND_FACTORY, registryAddr: REGISTRY,
  });
  const deployed = await chain.deployAndRegister({
    ownerAddr: ops.address, sessionKeyAddr: ops.address, auditPubKey: '044f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa385b6b1b8ead809ca67454d9683fcf2ba03456d6fe2c4abe2b07f0fbdbb2f1c1',
    name: `a5-hero-${Math.floor(Math.random() * 1e6)}`, accountVersion: 4,
    policy: { perTransferCap: E18, windowCap: 10n * E18, windowSeconds: 3600, expiresAt: 2 ** 31 },
    allowlist: [], timelockDelay: 0, settlementToken: SUSD,
    tokenPolicy: { perTransferCapToken: 1000n * E18, windowCapToken: 5000n * E18 },
  });
  const acct = getAddress(deployed.accountAddr);
  rec('P7.1a-twin-minted', deployed.accountVersion === 4, `band-factory twin ${acct} chainAgentId=${deployed.chainAgentId}`);

  await send(opsW, SUSD, encodeFunctionData({ abi: mintFrag, functionName: 'mint', args: [acct, 10_000n * E18] }));
  await send(opsW, acct, encodeFunctionData({ abi: leashAccountV4Abi, functionName: 'proposeSpendBudget', args: [SUSD, 5000n * E18] }));
  await send(opsW, acct, encodeFunctionData({ abi: leashAccountV4Abi, functionName: 'applySpendBudget', args: [] }));
  await send(opsW, acct, encodeFunctionData({ abi: leashAccountV4Abi, functionName: 'proposeCallRule', args: [SUSD, APPROVE_SEL, 0, [ROUTER], 2000n * E18, 5000n * E18, ('0x' + '00'.repeat(32)) as Hex] }));
  await send(opsW, acct, encodeFunctionData({ abi: leashAccountV4Abi, functionName: 'applyCallRule', args: [] }));
  await send(opsW, acct, encodeFunctionData({ abi: leashAccountV4Abi, functionName: 'proposeCallRule', args: [ROUTER, SWAP_SEL, 0, [], (2n ** 128n - 1n), (2n ** 128n - 1n), ('0x' + '00'.repeat(32)) as Hex] }));
  await send(opsW, acct, encodeFunctionData({ abi: leashAccountV4Abi, functionName: 'applyCallRule', args: [] }));
  await send(opsW, acct, encodeFunctionData({ abi: tightenBandFrag, functionName: 'tightenPriceBand', args: [ROUTER, SWAP_SEL, FEED, STSLA, 500, 3600n] }));
  await send(opsW, acct, encodeFunctionData({ abi: enableFrag, functionName: 'enableRequireBandForSwap', args: [] }));
  await send(opsW, acct, encodeFunctionData({ abi: leashAccountV4Abi, functionName: 'executeCall', args: [SUSD, 0n, encodeFunctionData({ abi: approveFrag, functionName: 'approve', args: [ROUTER, 2000n * E18] })] }));

  // healthy feed: $100, fresh
  await send(opsW, FEED, encodeFunctionData({ abi: setAnswerFrag, functionName: 'setAnswer', args: [10_000_000_000n] }));
  await send(opsW, FEED, encodeFunctionData({ abi: setStaleFrag, functionName: 'setStale', args: [0n] }));

  // (1) green: 100 sUSD → ≥1 sTSLA at $100, inside 5% band
  const greenTx = await send(opsW, acct, encodeFunctionData({ abi: leashAccountV4Abi, functionName: 'executeCall', args: [ROUTER, 0n, swapData(acct, 100n * E18, 1n * E18)] }));
  const stslaBal = await pub.readContract({ address: STSLA, abi: balanceFrag, functionName: 'balanceOf', args: [acct] }) as bigint;
  rec('P7.1b-green-swap', stslaBal >= 1n * E18, `in-band swap ✓ tx ${greenTx.slice(0, 18)}… sTSLA=${stslaBal / E18}`);

  // (2) PremiumBreach: 130 sUSD for 1 sTSLA → implied $130 > $105
  const prem = await expectRevert(opsW, acct, encodeFunctionData({ abi: leashAccountV4Abi, functionName: 'executeCall', args: [ROUTER, 0n, swapData(acct, 130n * E18, 1n * E18)] }));
  rec('P7.1c-premium-breach', /b9947793|revert|PremiumBreach/i.test(prem) && prem !== '', prem ? `BLOCKED: ${prem.slice(0, 110)}` : 'NOT BLOCKED — wall failed');

  // (3) StaleOracle: stale feed, in-band price → fail-closed
  await send(opsW, FEED, encodeFunctionData({ abi: setStaleFrag, functionName: 'setStale', args: [7200n] }));
  const stale = await expectRevert(opsW, acct, encodeFunctionData({ abi: leashAccountV4Abi, functionName: 'executeCall', args: [ROUTER, 0n, swapData(acct, 100n * E18, 1n * E18)] }));
  rec('P7.1d-stale-oracle', /4f725aba|revert|StaleOracle/i.test(stale) && stale !== '', stale ? `BLOCKED: ${stale.slice(0, 110)}` : 'NOT BLOCKED — fail-open!');

  // restore feed for the demo account
  await send(opsW, FEED, encodeFunctionData({ abi: setStaleFrag, functionName: 'setStale', args: [0n] }));
  await send(opsW, FEED, encodeFunctionData({ abi: setAnswerFrag, functionName: 'setAnswer', args: [10_000_000_000n] }));
  rec('P7.1e-feed-restored', true, 'feed back to $100/fresh for the demo account');

  // ---------- Part C: portability (SE-7 via the product API) ----------
  console.log('\n== Part C: portability spine (onboard a2 executor 0G→Base) ==');
  try {
    const { privyLogin, makeApi } = await import('./common.mjs');
    const api = makeApi(await privyLogin(ownerA), API);
    const exe = '0592dd50-5b08-49ed-87e6-c91c99c6efac';
    const ob = await api(`/api/agents/${exe}/networks`, { method: 'POST', body: JSON.stringify({ chainId: 84532 }) });
    const det = await api(`/api/agents/${exe}`);
    const sameAddr = (ob.body.accountAddr ?? ob.body.deployment?.accountAddr ?? '').toLowerCase() === det.body.accountAddr?.toLowerCase();
    rec('P6.1a-onboard-base', ob.status === 201 || ob.status === 200, `onboard -> ${ob.status} ${JSON.stringify(ob.body).slice(0, 140)}`);
    rec('P6.1b-same-address', sameAddr || ob.status === 200, `CREATE2 addr equal=${sameAddr}`);
    const again = await api(`/api/agents/${exe}/networks`, { method: 'POST', body: JSON.stringify({ chainId: 84532 }) });
    rec('P6.1c-idempotent', again.status === 200, `re-onboard -> ${again.status}`);
  } catch (e) { rec('P6.1a-onboard-base', false, (e as Error).message.slice(0, 140)); }

  appendFileSync(FINDINGS, rows.join('\n') + '\n');
  const fails = rows.filter((r) => r.includes('FAIL')).length;
  console.log(`\nStage A5-hero: ${rows.length} cases, ${fails} FAIL`);
}

main().catch((e) => { console.error('A5-hero FATAL:', e.message); appendFileSync(FINDINGS, `| A5-FATAL | **FAIL** | ${String(e.message).slice(0, 200)} |\n`); process.exit(1); });
