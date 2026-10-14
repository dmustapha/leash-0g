/**
 * WAVE-2 X6 — LIVE proof that the SHARED per-token spendBudget is cumulative and hard-capped.
 *
 * All five V5 money paths (execute / executeCall / executeTokenTransfer / authorizeSigningIntent
 * / swap-debit) debit the SAME `spendBudget[token]` via ONE chokepoint `_debitSpendBudget`
 * (LeashAccountV5.sol:667-677): read live b.spent → add → check ≤ windowCap → persist, all atomic
 * in one EVM tx. EVM serializes txs within a block, so there is no cross-path TOCTOU — the only
 * way to exceed the cap would be a non-cumulative/non-atomic debit. This drill proves cumulativity
 * live: repeated governed-call debits against ONE budget bucket, the running sum bounded by cap.
 *
 * Deploys a fresh V5 on Eth Sepolia (timelockDelay=0), arms (mockRouter, SEL_SWAP) with a HIGH
 * per-call cap (so per-call never trips) and sets spendBudget[tokenIn].windowCap = CAP. Then the
 * session key calls executeCall(swap) three times with amountIn = 0.6·CAP each:
 *   call 1  cumulative 0.6·CAP ≤ CAP  → wall passes (router runs)      [spent := 0.6·CAP]
 *   call 2  cumulative 1.2·CAP > CAP  → REVERTS OverCumulativeSpend    [spent unchanged]
 *   call 3  cumulative still 1.2·CAP  → REVERTS OverCumulativeSpend    [idempotent: no partial debit]
 * The 2nd/3rd reverts prove the debit is cumulative (sums across calls) AND atomic (a reverted
 * call leaves spent untouched — no partial debit leaks capacity). Single chokepoint ⇒ this bound
 * holds identically for every path that debits the bucket.
 *
 * Run:  npx tsx scripts/tearapart/wave2-x6-shared-budget-live.mts   (SPENDS Eth-Sepolia gas, ops pays)
 */
import { readFileSync } from 'node:fs';
import {
  createPublicClient, createWalletClient, http, defineChain, parseAbi,
  encodeFunctionData, decodeErrorResult, getAddress, type Hex, type Abi,
} from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

function env(key: string): string {
  if (process.env[key]) return process.env[key] as string;
  for (const line of readFileSync(new URL('../../.env', import.meta.url), 'utf8').split('\n')) {
    const t = line.trim();
    if (t.startsWith(`${key}=`)) return t.slice(key.length + 1).replace(/^"|"$/g, '');
  }
  throw new Error(`missing ${key} in backend/.env`);
}
function loadArtifact(name: string): { abi: Abi; bytecode: { object: Hex } } {
  return JSON.parse(readFileSync(new URL(`../../../contracts/out/${name}.sol/${name}.json`, import.meta.url), 'utf8')) as { abi: Abi; bytecode: { object: Hex } };
}
const artifact = loadArtifact('LeashAccountV5');
const SIGNING_HELPER = env('LEASH_SIGNING_HELPER_ADDR') as Hex;
const DECODE_HELPER = env('LEASH_DECODE_HELPER_ADDR') as Hex;
const SWAP_ABI = parseAbi(['function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin, address recipient, uint256 deadline)']);
const SEL_SWAP = '0x9908fc8b' as Hex;
const SPEC = { name: 'Ethereum Sepolia', chainId: 11155111, rpcEnv: 'ETHEREUM_SEPOLIA_RPC' };

function ctx() {
  const rpc = env(SPEC.rpcEnv);
  const opsRaw = env('OPS_PRIVATE_KEY');
  const ops = privateKeyToAccount((opsRaw.startsWith('0x') ? opsRaw : `0x${opsRaw}`) as Hex);
  const chain = defineChain({ id: SPEC.chainId, name: SPEC.name, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  return { rpc, ops, chain, pub: createPublicClient({ chain, transport: http(rpc) }), wallet: createWalletClient({ chain, transport: http(rpc), account: ops }) };
}
type Ctx = ReturnType<typeof ctx>;
async function pollRead<T>(read: () => Promise<T>, ok: (v: T) => boolean, tries = 20, delayMs = 2000): Promise<T> {
  let last!: T;
  for (let i = 0; i < tries; i++) { try { last = await read(); if (ok(last)) return last; } catch { /* lag */ } await new Promise((r) => setTimeout(r, delayMs)); }
  return last;
}
function revertErrorName(data: Hex | undefined): string {
  if (!data || data === '0x' || data.length < 10) return '';
  try { return decodeErrorResult({ abi: artifact.abi, data }).errorName; } catch { return ''; }
}
async function deployAccount(c: Ctx, owner: Hex, session: Hex, token: Hex): Promise<Hex> {
  const now = Math.floor(Date.now() / 1000);
  const policy = { perTransferCap: 0n, windowCap: 0n, windowSeconds: 3600, expiresAt: BigInt(now + 365 * 24 * 3600) };
  const h = await c.wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [owner, owner, session, policy, [], 0n, token, { perTransferCapToken: 0n, windowCapToken: 0n }, SIGNING_HELPER, DECODE_HELPER] });
  const rc = await c.pub.waitForTransactionReceipt({ hash: h });
  if (!rc.contractAddress) throw new Error('no account addr'); return rc.contractAddress;
}
async function deployMockRouter(c: Ctx): Promise<Hex> {
  const h = await c.wallet.sendTransaction({ data: ('0x600a600c600039600a6000f3' + '600160005260206000f3') as Hex });
  const rc = await c.pub.waitForTransactionReceipt({ hash: h });
  if (!rc.contractAddress) throw new Error('no router'); return rc.contractAddress;
}
async function armCallRule(c: Ctx, account: Hex, router: Hex, perCallCap: bigint, windowCapCall: bigint) {
  const ph = await c.wallet.writeContract({ address: account, abi: artifact.abi, functionName: 'proposeCallRule', args: [router, SEL_SWAP, 0, [], perCallCap, windowCapCall, '0x0000000000000000000000000000000000000000000000000000000000000000'] });
  if ((await c.pub.waitForTransactionReceipt({ hash: ph })).status !== 'success') throw new Error('proposeCallRule reverted');
  await pollRead(() => c.pub.readContract({ address: account, abi: artifact.abi, functionName: 'pendingCallRule', args: [] }) as Promise<unknown[]>, (v) => BigInt((v[6] as bigint) ?? 0n) !== 0n);
  const ah = await c.wallet.writeContract({ address: account, abi: artifact.abi, functionName: 'applyCallRule', args: [] });
  if ((await c.pub.waitForTransactionReceipt({ hash: ah })).status !== 'success') throw new Error('applyCallRule reverted');
}
async function setBudget(c: Ctx, account: Hex, token: Hex, windowCap: bigint) {
  const ph = await c.wallet.writeContract({ address: account, abi: artifact.abi, functionName: 'proposeSpendBudget', args: [token, windowCap] });
  if ((await c.pub.waitForTransactionReceipt({ hash: ph })).status !== 'success') throw new Error('proposeSpendBudget reverted');
  const ah = await c.wallet.writeContract({ address: account, abi: artifact.abi, functionName: 'applySpendBudget', args: [] });
  if ((await c.pub.waitForTransactionReceipt({ hash: ah })).status !== 'success') throw new Error('applySpendBudget reverted');
}
function swapCalldata(tokenIn: Hex, tokenOut: Hex, amountIn: bigint, recipient: Hex): Hex {
  return encodeFunctionData({ abi: SWAP_ABI, functionName: 'swap', args: [tokenIn, tokenOut, amountIn, 1n, recipient, BigInt(Math.floor(Date.now() / 1000) + 3600)] });
}
type Outcome = { status: 'success' | 'reverted'; errorName: string; txHash: Hex };
async function sessionExecuteCall(c: Ctx, sw: ReturnType<typeof createWalletClient>, account: Hex, target: Hex, data: Hex, session: Hex): Promise<Outcome> {
  const callData = encodeFunctionData({ abi: artifact.abi, functionName: 'executeCall', args: [target, 0n, data] });
  let errorName = '';
  try { await c.pub.call({ account: session, to: account, data: callData }); }
  catch (err) { const raw = (err as { walk?: (fn: (e: unknown) => boolean) => unknown }).walk?.((e) => (e as { data?: unknown }).data !== undefined) as { data?: Hex } | undefined; errorName = revertErrorName(raw?.data); }
  const txHash = await sw.sendTransaction({ chain: c.chain, to: account, data: callData, gas: 500_000n } as never);
  const rc = await c.pub.waitForTransactionReceipt({ hash: txHash });
  return { status: rc.status, errorName, txHash };
}
async function readSpent(c: Ctx, account: Hex, token: Hex): Promise<bigint> {
  const b = await c.pub.readContract({ address: account, abi: artifact.abi, functionName: 'spendBudget', args: [token] }) as unknown[];
  // SpendBudget tuple order: (set, windowCap, spent, windowStart) — spent is index 2.
  return BigInt((b[2] as bigint) ?? 0n);
}

async function run(): Promise<void> {
  const c = ctx();
  const session = generatePrivateKey();
  const sessionAcct = privateKeyToAccount(session);
  const sessionWallet = createWalletClient({ chain: c.chain, transport: http(c.rpc), account: sessionAcct });
  const tokenIn = getAddress('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238') as Hex;
  const tokenOut = getAddress('0x779877A7B0D9E8603169DdbD7836e478b4624789') as Hex;

  const CAP = 1_000_000_000_000_000_000n;      // spendBudget[tokenIn] window cap = 1e18
  const perCallCap = 10n * CAP;                 // per-call cap HIGH so it never trips (isolate the cumulative bucket)
  const windowCapCall = 10n * CAP;              // call-window cap HIGH too
  const amt = (CAP * 6n) / 10n;                 // 0.6·CAP per call

  const account = await deployAccount(c, c.ops.address as Hex, sessionAcct.address as Hex, tokenIn);
  await c.pub.waitForTransactionReceipt({ hash: await c.wallet.sendTransaction({ to: sessionAcct.address, value: 20_000_000_000_000_000n }) });
  const router = await deployMockRouter(c);
  await armCallRule(c, account, router, perCallCap, windowCapCall);
  await setBudget(c, account, tokenIn, CAP);
  console.log(`\n[${SPEC.name}] account=${account} router=${router}  spendBudget[tokenIn].cap=1e18, per-call amt=0.6e18`);

  const r1 = await sessionExecuteCall(c, sessionWallet, account, router, swapCalldata(tokenIn, tokenOut, amt, account), sessionAcct.address as Hex);
  // pollRead past read-replica lag: the debit from call1 must be visible before we compare.
  const s1 = await pollRead(() => readSpent(c, account, tokenIn), (v) => v === amt);
  const r2 = await sessionExecuteCall(c, sessionWallet, account, router, swapCalldata(tokenIn, tokenOut, amt, account), sessionAcct.address as Hex);
  const s2 = await readSpent(c, account, tokenIn);
  const r3 = await sessionExecuteCall(c, sessionWallet, account, router, swapCalldata(tokenIn, tokenOut, amt, account), sessionAcct.address as Hex);
  const s3 = await readSpent(c, account, tokenIn);

  const c1 = r1.status === 'success';                                             // first debit lands
  const c2 = r2.status === 'reverted' && r2.errorName === 'OverCumulativeSpend';  // cumulative trips cap
  const c3 = r3.status === 'reverted' && r3.errorName === 'OverCumulativeSpend';  // still capped (no partial leak)
  const cAtomic = s1 === amt && s2 === amt && s3 === amt;                          // spent frozen after the first — no partial debit

  console.log('\n=== WAVE-2 X6 — SHARED BUDGET CUMULATIVE + ATOMIC (LIVE) ===');
  console.log(`${c1 ? '✅' : '❌'} call1 (Σ=0.6e18 ≤ cap)   → status=${r1.status} err=${r1.errorName || '-'}  spent=${s1}  tx=${r1.txHash.slice(0, 12)}..`);
  console.log(`${c2 ? '✅' : '❌'} call2 (Σ=1.2e18 > cap)   → status=${r2.status} err=${r2.errorName || '-'}  spent=${s2}  tx=${r2.txHash.slice(0, 12)}..`);
  console.log(`${c3 ? '✅' : '❌'} call3 (Σ still > cap)    → status=${r3.status} err=${r3.errorName || '-'}  spent=${s3}  tx=${r3.txHash.slice(0, 12)}..`);
  console.log(`${cAtomic ? '✅' : '❌'} atomicity: spent frozen at 0.6e18 across the two reverts (no partial debit leaked capacity)`);
  console.log(`\nAll 5 money paths debit this SAME bucket through one chokepoint (_debitSpendBudget) — cumulative spend is hard-bounded by windowCap within a window, atomically, with no cross-path TOCTOU (EVM serializes txs).`);
  const allOk = c1 && c2 && c3 && cAtomic;
  console.log(allOk ? '\nSHARED BUDGET HOLDS LIVE ✅' : '\nFAILURES PRESENT ❌');
  process.exit(allOk ? 0 : 1);
}
run().catch((e) => { console.error(e); process.exit(1); });
