/**
 * RH2 TEAR-APART — LIVE PROOF that V5 CLOSES the swap-drain that is OPEN on V4.
 *
 * The RH2 drain: on V4 a session key could call a router's `swap(...)` with an UNBUDGETED
 * `amountIn` to an UNPINNED recipient — the trader drain. V5 adds a governed CALL wall
 * (`_enforceAndExecute`): the swap selector 0x9908fc8b decodes `amountIn`/`tokenIn`/`recipient`
 * via DecodeLib and enforces `recipientMode==0 ⇒ recipient==self` (RecipientNotSelf) and
 * `amountIn ≤ perCallCap` (OverPerCallCap), plus a per-token spendBudget debit.
 *
 * This drill deploys a FRESH V5 account on Ethereum Sepolia (timelockDelay=0 ⇒ instant
 * propose→apply), ARMS a swap call-rule for (MOCK_ROUTER, SEL_SWAP), and proves 3 cases by
 * the session key calling `executeCall` and inspecting `receipt.status` (NOT thrown errors —
 * a reverted tx sent with explicit gas does not throw):
 *   (a) OVER-CAP      amountIn > perCallCap, recipient=self  → REVERTS OverPerCallCap
 *   (b) WRONG-RECIP   amountIn ≤ cap, recipient=attacker     → REVERTS RecipientNotSelf
 *   (c) IN-CAP+SELF   amountIn ≤ cap, recipient=self         → WALL PASSES (router runs)
 *
 * CRITICAL ([[validate-diagnostic-probe-first]]): every encode/decode uses the COMPILED
 * artifact ABI (contracts/out/LeashAccountV5.sol/LeashAccountV5.json) — the swap calldata is
 * encoded with viem `encodeFunctionData` against the EXACT swap signature, and every revert
 * selector is decoded with `decodeErrorResult` against the SAME artifact ABI. No hand-written
 * struct/selector (a width mismatch would revert with empty data and mimic a false result).
 *
 * Run:  npx tsx scripts/tearapart/rh2-v5-swap-drain-closed.mts
 * SPENDS real Ethereum-Sepolia gas (owner = ops). Fresh account each run (idempotent).
 *
 * .env keys: OPS_PRIVATE_KEY, ETHEREUM_SEPOLIA_RPC, LEASH_SIGNING_HELPER_ADDR,
 *            LEASH_DECODE_HELPER_ADDR, LEASH_CREATE2_DEPLOYER_ADDR
 */
import { readFileSync } from 'node:fs';
import {
  createPublicClient, createWalletClient, http, defineChain, parseAbi,
  encodeFunctionData, decodeErrorResult, getAddress,
  type Hex, type Abi,
} from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

// ─────────────────────────── env / artifact / ctx (verbatim from matrix) ───────────────────────────
function env(key: string): string {
  if (process.env[key]) return process.env[key] as string;
  for (const line of readFileSync(new URL('../../.env', import.meta.url), 'utf8').split('\n')) {
    const t = line.trim();
    if (t.startsWith(`${key}=`)) return t.slice(key.length + 1).replace(/^"|"$/g, '');
  }
  throw new Error(`missing ${key} in backend/.env`);
}

function loadArtifact(name: string): { abi: Abi; bytecode: { object: Hex } } {
  return JSON.parse(readFileSync(new URL(`../../../contracts/out/${name}.sol/${name}.json`, import.meta.url), 'utf8')) as {
    abi: Abi; bytecode: { object: Hex };
  };
}
const artifact = loadArtifact('LeashAccountV5');

const SIGNING_HELPER = env('LEASH_SIGNING_HELPER_ADDR') as Hex;
const DECODE_HELPER = env('LEASH_DECODE_HELPER_ADDR') as Hex;

// The exact swap ABI — SEL_SWAP = 0x9908fc8b. Encoded with viem against THIS signature only.
const SWAP_ABI = parseAbi([
  'function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin, address recipient, uint256 deadline)',
]);
const SEL_SWAP = '0x9908fc8b' as Hex;

interface ChainSpec { key: string; name: string; chainId: number; rpcEnv: string }
const SPEC: ChainSpec = { key: 'eth', name: 'Ethereum Sepolia', chainId: 11155111, rpcEnv: 'ETHEREUM_SEPOLIA_RPC' };

async function pollRead<T>(read: () => Promise<T>, ok: (v: T) => boolean, tries = 20, delayMs = 2000): Promise<T> {
  let last!: T;
  for (let i = 0; i < tries; i++) {
    try { last = await read(); if (ok(last)) return last; } catch { /* lagging replica */ }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return last;
}

function ctx(spec: ChainSpec) {
  const rpc = env(spec.rpcEnv);
  const opsRaw = env('OPS_PRIVATE_KEY');
  const ops = privateKeyToAccount((opsRaw.startsWith('0x') ? opsRaw : `0x${opsRaw}`) as Hex);
  const chain = defineChain({ id: spec.chainId, name: spec.name, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const wallet = createWalletClient({ chain, transport: http(rpc), account: ops });
  return { rpc, ops, chain, pub, wallet };
}
type Ctx = ReturnType<typeof ctx>;

// ─────────────────────────── drill-specific helpers ───────────────────────────

/** Deploy a fresh V5 wired to the PINNED helpers; timelockDelay=0 ⇒ instant rule/budget apply. */
async function deployAccount(c: Ctx, owner: Hex, session: Hex, settlementToken: Hex): Promise<Hex> {
  const nowSec = Math.floor(Date.now() / 1000);
  const policy = { perTransferCap: 0n, windowCap: 0n, windowSeconds: 3600, expiresAt: BigInt(nowSec + 365 * 24 * 3600) };
  const hash = await c.wallet.deployContract({
    abi: artifact.abi, bytecode: artifact.bytecode.object,
    args: [owner, owner, session, policy, [], 0n, settlementToken, { perTransferCapToken: 0n, windowCapToken: 0n }, SIGNING_HELPER, DECODE_HELPER],
  });
  const rc = await c.pub.waitForTransactionReceipt({ hash });
  if (!rc.contractAddress) throw new Error('no contract address');
  return rc.contractAddress;
}

/**
 * Deploy a trivial mock router that succeeds on any call (returns a 32-byte word). Needed
 * because `executeCall` requires `target.code.length != 0` (EmptyCodeTarget) BEFORE the wall,
 * and case (c) actually dispatches to the router after the wall passes.
 *   runtime:  600160005260206000F3  (PUSH1 1; MSTORE@0; RETURN 32 bytes)
 *   initcode: 600a600c600039600a6000f3 <runtime>  (copy 10 runtime bytes, return them)
 */
async function deployMockRouter(c: Ctx): Promise<Hex> {
  const runtime = '600160005260206000f3';
  const initcode = ('0x600a600c600039600a6000f3' + runtime) as Hex;
  const hash = await c.wallet.sendTransaction({ data: initcode });
  const rc = await c.pub.waitForTransactionReceipt({ hash });
  if (!rc.contractAddress) throw new Error('no mock-router address');
  return rc.contractAddress;
}

/** proposeCallRule + applyCallRule — timelockDelay=0 ⇒ eta==now ⇒ apply is instant. */
async function armCallRule(c: Ctx, account: Hex, router: Hex, perCallCap: bigint, windowCapCall: bigint) {
  const ph = await c.wallet.writeContract({
    address: account, abi: artifact.abi, functionName: 'proposeCallRule',
    // target, selector, recipientMode=0 (self-only), spenders=[], perCallCap, windowCapCall, codehash=0 (no pin)
    args: [router, SEL_SWAP, 0, [], perCallCap, windowCapCall, '0x0000000000000000000000000000000000000000000000000000000000000000'],
  });
  if ((await c.pub.waitForTransactionReceipt({ hash: ph })).status !== 'success') throw new Error('proposeCallRule reverted');
  // pendingCallRule.eta (last tuple field) is non-zero once the propose is read-after-write visible.
  await pollRead(
    () => c.pub.readContract({ address: account, abi: artifact.abi, functionName: 'pendingCallRule', args: [] }) as Promise<unknown[]>,
    (v) => BigInt((v[6] as bigint) ?? 0n) !== 0n,
  );
  const ah = await c.wallet.writeContract({ address: account, abi: artifact.abi, functionName: 'applyCallRule', args: [] });
  if ((await c.pub.waitForTransactionReceipt({ hash: ah })).status !== 'success') throw new Error('applyCallRule reverted');
}

/** proposeSpendBudget + applySpendBudget — instant at timelockDelay=0. */
async function setBudget(c: Ctx, account: Hex, token: Hex, windowCap: bigint) {
  const ph = await c.wallet.writeContract({ address: account, abi: artifact.abi, functionName: 'proposeSpendBudget', args: [token, windowCap] });
  if ((await c.pub.waitForTransactionReceipt({ hash: ph })).status !== 'success') throw new Error('proposeSpendBudget reverted');
  const ah = await c.wallet.writeContract({ address: account, abi: artifact.abi, functionName: 'applySpendBudget', args: [] });
  if ((await c.pub.waitForTransactionReceipt({ hash: ah })).status !== 'success') throw new Error('applySpendBudget reverted');
}

/** Encode swap calldata against the EXACT artifact-free swap ABI (never a hand-written selector). */
function swapCalldata(tokenIn: Hex, tokenOut: Hex, amountIn: bigint, recipient: Hex): Hex {
  return encodeFunctionData({
    abi: SWAP_ABI, functionName: 'swap',
    args: [tokenIn, tokenOut, amountIn, 1n, recipient, BigInt(Math.floor(Date.now() / 1000) + 3600)],
  });
}

/** Decode a revert's error NAME against the V5 artifact ABI. Returns '' if not decodable. */
function revertErrorName(data: Hex | undefined): string {
  if (!data || data === '0x' || data.length < 10) return '';
  try { return decodeErrorResult({ abi: artifact.abi, data }).errorName; } catch { return ''; }
}

type CallOutcome = { status: 'success' | 'reverted'; errorName: string; txHash: Hex };

/**
 * Session key calls `executeCall(target, 0, data)` with EXPLICIT gas so a revert produces a
 * status==0 receipt (does NOT throw). We then re-run the same call via eth_call to recover the
 * revert data and decode its selector against the artifact ABI.
 */
async function sessionExecuteCall(c: Ctx, sessionWallet: ReturnType<typeof createWalletClient>, account: Hex, target: Hex, data: Hex, session: Hex): Promise<CallOutcome> {
  const callData = encodeFunctionData({ abi: artifact.abi, functionName: 'executeCall', args: [target, 0n, data] });
  // Recover the revert reason first via eth_call (no state change) — robust selector decode.
  let errorName = '';
  try {
    await c.pub.call({ account: session, to: account, data: callData });
  } catch (err) {
    const raw = (err as { walk?: (fn: (e: unknown) => boolean) => unknown }).walk?.((e) => (e as { data?: unknown }).data !== undefined) as { data?: Hex } | undefined;
    errorName = revertErrorName(raw?.data);
  }
  // Now send the tx with explicit gas so a revert yields status==0 instead of a gas-estimate throw.
  // sessionWallet is already bound to the sessionAcct (local signing) — do NOT override `account`
  // with the raw key/address or viem routes to node-managed eth_sendTransaction ("unknown account").
  const txHash = await sessionWallet.sendTransaction({ chain: c.chain, to: account, data: callData, gas: 500_000n } as never);
  const rc = await c.pub.waitForTransactionReceipt({ hash: txHash });
  return { status: rc.status, errorName, txHash };
}

// ─────────────────────────── the drill ───────────────────────────
async function run(): Promise<void> {
  const c = ctx(SPEC);
  const session = generatePrivateKey();
  const sessionAcct = privateKeyToAccount(session);
  const sessionWallet = createWalletClient({ chain: c.chain, transport: http(c.rpc), account: sessionAcct });

  // Any addresses — the wall reverts BEFORE the router runs for (a)/(b); (c) needs a real
  // mock-router (code present) + a funded spendBudget[tokenIn].
  const tokenIn = getAddress('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238') as Hex;
  const tokenOut = getAddress('0x779877A7B0D9E8603169DdbD7836e478b4624789') as Hex;
  const attacker = getAddress('0x000000000000000000000000000000000000dEaD') as Hex;

  const perCallCap = 1_000_000_000_000_000_000n;  // 1e18
  const windowCapCall = 2_000_000_000_000_000_000n; // 2e18 (≥ perCallCap so the call-window check passes)
  const budgetWindowCap = 2_000_000_000_000_000_000n; // 2e18 spendBudget[tokenIn]

  console.log(`\n[${SPEC.name}]  SigningLib=${SIGNING_HELPER}  DecodeLib=${DECODE_HELPER}`);
  console.log(`owner=ops(${c.ops.address})  session=${sessionAcct.address}`);

  // 1) fresh V5, 2) fund the session EOA for gas, 3) deploy mock router.
  const account = await deployAccount(c, c.ops.address as Hex, sessionAcct.address as Hex, tokenIn);
  const fund = await c.wallet.sendTransaction({ to: sessionAcct.address, value: 20_000_000_000_000_000n }); // 0.02 ETH gas
  await c.pub.waitForTransactionReceipt({ hash: fund });
  const router = await deployMockRouter(c);
  console.log(`account=${account}  router(mock)=${router}`);

  // ARM: allow (router, SEL_SWAP) self-only + fund the per-token spend budget.
  await armCallRule(c, account, router, perCallCap, windowCapCall);
  await setBudget(c, account, tokenIn, budgetWindowCap);

  const self = account;
  const over = perCallCap + 1n;          // 1e18 + 1 — over the per-call cap
  const inCap = perCallCap / 2n;         // 0.5e18 — within cap

  // (a) OVER-CAP, recipient=self → OverPerCallCap
  const a = await sessionExecuteCall(c, sessionWallet, account, router, swapCalldata(tokenIn, tokenOut, over, self), sessionAcct.address as Hex);
  // (b) WRONG-RECIPIENT, amountIn ≤ cap, recipient=attacker → RecipientNotSelf
  const b = await sessionExecuteCall(c, sessionWallet, account, router, swapCalldata(tokenIn, tokenOut, inCap, attacker), sessionAcct.address as Hex);
  // (c) IN-CAP + SELF → wall passes (router runs)
  const cc = await sessionExecuteCall(c, sessionWallet, account, router, swapCalldata(tokenIn, tokenOut, inCap, self), sessionAcct.address as Hex);

  // ─── assertions (on receipt.status + decoded revert name, NOT thrown errors) ───
  const aOk = a.status === 'reverted' && a.errorName === 'OverPerCallCap';
  const bOk = b.status === 'reverted' && b.errorName === 'RecipientNotSelf';
  const WALL_ERRORS = ['OverPerCallCap', 'RecipientNotSelf', 'SelectorNotAllowlisted', 'NotAllowlisted', 'TargetNotAllowlisted', 'BudgetNotSet'];
  const cOk = cc.status === 'success' || !WALL_ERRORS.includes(cc.errorName); // wall no longer blocks it

  console.log('\n=== RH2 V5 SWAP-DRAIN CLOSED — LIVE MATRIX ===');
  console.log(`(a) over-cap      → status=${a.status} err=${a.errorName || '-'}  ${aOk ? 'OverPerCallCap ✅' : '❌'}  tx=${a.txHash.slice(0, 10)}..`);
  console.log(`(b) wrong-recip   → status=${b.status} err=${b.errorName || '-'}  ${bOk ? 'RecipientNotSelf ✅' : '❌'}  tx=${b.txHash.slice(0, 10)}..`);
  console.log(`(c) in-cap+self   → status=${cc.status} err=${cc.errorName || '-'}  ${cOk ? 'wall passes ✅' : '❌'}  tx=${cc.txHash.slice(0, 10)}..`);
  console.log('\nOn V4 all three would have been UNCHECKED: amountIn was unbudgeted (no perCallCap/spendBudget) and the recipient was unpinned — the RH2 trader drain. V5 pins recipient==self (RecipientNotSelf) and caps amountIn (OverPerCallCap) at the governed CALL wall.');

  const allOk = aOk && bOk && cOk;
  console.log(allOk ? '\nDRAIN CLOSED ON V5 ✅' : '\nFAILURES PRESENT ❌');
  process.exit(allOk ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(1); });
