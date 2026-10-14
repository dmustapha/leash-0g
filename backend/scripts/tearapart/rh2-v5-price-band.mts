/**
 * RH2 TEAR-APART — LIVE PROOF of the V5 PRICE-BAND WALL (oracle-premium + oracle-health
 * guards) on-chain. The RH2 band guard was only ever proven LIVE on V4 (the capability-hero
 * drill). This drill proves the SAME guard now exists on V5, on Ethereum Sepolia.
 *
 * The wall: V5 `_enforceAndExecute` → `_checkPriceBand` → DecodeLib.checkPriceBand reads a
 * Chainlink feed via STATICCALL and, for the SEL_SWAP selector 0x9908fc8b, enforces:
 *   - oracle health: answer>0 (OraclePriceInvalid), fresh updatedAt (StaleOracle),
 *     answeredInRound>=roundId (OraclePriceInvalid), call-not-reverted (OracleCallFailed)
 *   - premium bound: impliedPrice18 = amountIn*1e18/amountOutMin must be
 *     <= oracle18*(1+bps) where oracle18 = answer*1e10 (8dp→18dp scale) — else PremiumBreach.
 *
 * This drill deploys a FRESH V5 account on Ethereum Sepolia (timelockDelay=0), a controllable
 * MockAggregatorV3 feed (8dp), an 18dp MockERC20 as the priced asset (tokenOut), and a trivial
 * mock router. It ARMS: a swap call-rule (perCallCap + spendBudget so an in-cap swap can be
 * attempted) + a price band on (router, SEL_SWAP) via the OWNER using the INSTANT `tightenPriceBand`
 * arm (a fresh band is a tighten — instant at any timelockDelay), then `enableRequireBandForSwap`.
 * It then proves 4 cases by the SESSION key calling `executeCall` and inspecting `receipt.status`
 * (NOT thrown errors — a reverted tx sent with explicit gas does not throw):
 *   (a) IN-BAND     fresh feed, impliedPrice <= oracle*(1+bps)   → WALL PASSES (not a band error)
 *   (b) PREMIUM     amountOutMin too small ⇒ implied > maxPrice  → REVERTS PremiumBreach
 *   (c) STALE       feed.setStale(age > maxStaleness)            → REVERTS StaleOracle
 *   (d) INVALID     feed.setAnswer(0)  (answer <= 0)             → REVERTS OraclePriceInvalid
 *
 * CRITICAL ([[validate-diagnostic-probe-first]]): every encode/decode uses the COMPILED artifact
 * ABI — swap calldata encoded with viem against the EXACT swap signature, every revert selector
 * decoded with `decodeErrorResult` against the V5 artifact ABI (which carries PremiumBreach /
 * StaleOracle / OraclePriceInvalid). No hand-written struct/selector.
 *
 * Run:  npx tsx scripts/tearapart/rh2-v5-price-band.mts
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

// ─────────────────────────── env / artifact / ctx (verbatim from the sibling) ───────────────────────────
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
const feedArtifact = loadArtifact('MockAggregatorV3');
const tokenArtifact = loadArtifact('MockERC20');

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

/** Deploy a fresh V5 wired to the PINNED helpers; timelockDelay=0. settlementToken = asset. */
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

/** Deploy the controllable 8dp Chainlink mock feed with an initial answer. */
async function deployFeed(c: Ctx, initialAnswer: bigint): Promise<Hex> {
  const hash = await c.wallet.deployContract({ abi: feedArtifact.abi, bytecode: feedArtifact.bytecode.object, args: [initialAnswer] });
  const rc = await c.pub.waitForTransactionReceipt({ hash });
  if (!rc.contractAddress) throw new Error('no feed address');
  return rc.contractAddress;
}

/** Deploy an 18dp MockERC20 to serve as the priced asset (tokenOut) — the band pins asset to 18dp. */
async function deployAsset18(c: Ctx): Promise<Hex> {
  const hash = await c.wallet.deployContract({ abi: tokenArtifact.abi, bytecode: tokenArtifact.bytecode.object, args: ['MockOut', 'MOUT', 18] });
  const rc = await c.pub.waitForTransactionReceipt({ hash });
  if (!rc.contractAddress) throw new Error('no asset address');
  return rc.contractAddress;
}

/**
 * Deploy a trivial mock router that succeeds on any call (returns a 32-byte word). `executeCall`
 * requires `target.code.length != 0` (EmptyCodeTarget), and case (a) dispatches after the wall passes.
 *   runtime:  600160005260206000F3  (PUSH1 1; MSTORE@0; RETURN 32 bytes)
 *   initcode: 600a600c600039600a6000f3 <runtime>
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
    args: [router, SEL_SWAP, 0, [], perCallCap, windowCapCall, '0x0000000000000000000000000000000000000000000000000000000000000000'],
  });
  if ((await c.pub.waitForTransactionReceipt({ hash: ph })).status !== 'success') throw new Error('proposeCallRule reverted');
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

/**
 * INSTANT band arm: a FRESH band (b.set==false) is a "tighten" — `tightenPriceBand` sets it
 * in one owner tx at ANY timelockDelay (no propose/apply needed). feed=8dp mock, asset=tokenOut(18dp).
 */
async function armPriceBand(c: Ctx, account: Hex, router: Hex, feed: Hex, asset: Hex, maxDeviationBps: number, maxStaleness: bigint) {
  const h = await c.wallet.writeContract({
    address: account, abi: artifact.abi, functionName: 'tightenPriceBand',
    args: [router, SEL_SWAP, feed, asset, maxDeviationBps, maxStaleness],
  });
  if ((await c.pub.waitForTransactionReceipt({ hash: h })).status !== 'success') throw new Error('tightenPriceBand reverted');
  const e = await c.wallet.writeContract({ address: account, abi: artifact.abi, functionName: 'enableRequireBandForSwap', args: [] });
  if ((await c.pub.waitForTransactionReceipt({ hash: e })).status !== 'success') throw new Error('enableRequireBandForSwap reverted');
}

/** Drive the mock feed: fresh answer (bumps round, updatedAt=now). Owner tx. */
async function feedSetAnswer(c: Ctx, feed: Hex, answer: bigint) {
  const h = await c.wallet.writeContract({ address: feed, abi: feedArtifact.abi, functionName: 'setAnswer', args: [answer] });
  await c.pub.waitForTransactionReceipt({ hash: h });
}
/** Force the feed stale: updatedAt set `age` seconds in the past. Owner tx. */
async function feedSetStale(c: Ctx, feed: Hex, age: bigint) {
  const h = await c.wallet.writeContract({ address: feed, abi: feedArtifact.abi, functionName: 'setStale', args: [age] });
  await c.pub.waitForTransactionReceipt({ hash: h });
}

/** Encode swap calldata against the EXACT swap ABI (never a hand-written selector). */
function swapCalldata(tokenIn: Hex, tokenOut: Hex, amountIn: bigint, amountOutMin: bigint, recipient: Hex): Hex {
  return encodeFunctionData({
    abi: SWAP_ABI, functionName: 'swap',
    args: [tokenIn, tokenOut, amountIn, amountOutMin, recipient, BigInt(Math.floor(Date.now() / 1000) + 3600)],
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
 * status==0 receipt (does NOT throw). Revert data recovered via a prior eth_call for a robust
 * selector decode. sessionWallet is already bound to the sessionAcct (local signing) — do NOT
 * override `account` or viem routes to node-managed eth_sendTransaction ("unknown account").
 */
async function sessionExecuteCall(c: Ctx, sessionWallet: ReturnType<typeof createWalletClient>, account: Hex, target: Hex, data: Hex, session: Hex): Promise<CallOutcome> {
  const callData = encodeFunctionData({ abi: artifact.abi, functionName: 'executeCall', args: [target, 0n, data] });
  let errorName = '';
  try {
    await c.pub.call({ account: session, to: account, data: callData });
  } catch (err) {
    const raw = (err as { walk?: (fn: (e: unknown) => boolean) => unknown }).walk?.((e) => (e as { data?: unknown }).data !== undefined) as { data?: Hex } | undefined;
    errorName = revertErrorName(raw?.data);
  }
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

  // Band math: oracle answer=100e8 (8dp price 100) ⇒ oracle18 = 100e8 * 1e10 = 1e20.
  // maxDeviationBps=100 (1%) ⇒ maxPrice = 1e20 * 10100/10000 = 1.01e20.
  // impliedPrice18 = amountIn*1e18/amountOutMin.
  //   in-band (a): amountIn=1e18, amountOutMin=1e16 ⇒ implied = 1e36/1e16 = 1e20 ≤ 1.01e20 ✓
  //   premium (b): amountIn=1e18, amountOutMin=9e15 ⇒ implied = 1e36/9e15 ≈ 1.111e20 > 1.01e20 ✗
  const ORACLE_ANSWER = 100_00000000n;             // 100 * 1e8 (8dp)
  const MAX_DEV_BPS = 100;                          // 1%
  const MAX_STALENESS = 3600n;                      // 1h
  const amountIn = 1_000_000_000_000_000_000n;      // 1e18 (== perCallCap)
  const outInBand = 10_000_000_000_000_000n;        // 1e16 → implied = 1e20 (in-band)
  const outPremium = 9_000_000_000_000_000n;        // 9e15 → implied ≈ 1.111e20 (breach)

  const perCallCap = 1_000_000_000_000_000_000n;    // 1e18 (amountIn in-cap)
  const windowCapCall = 4_000_000_000_000_000_000n; // 4e18 (≥ sum of in-cap attempts)
  const budgetWindowCap = 8_000_000_000_000_000_000n; // 8e18 spendBudget[tokenIn]

  const tokenIn = getAddress('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238') as Hex; // any addr (budget keyed on this)

  console.log(`\n[${SPEC.name}]  SigningLib=${SIGNING_HELPER}  DecodeLib=${DECODE_HELPER}`);
  console.log(`owner=ops(${c.ops.address})  session=${sessionAcct.address}`);

  // 1) 18dp priced asset (tokenOut), 2) 8dp feed, 3) fresh V5 (settlementToken=asset), 4) fund session gas, 5) mock router.
  const asset = await deployAsset18(c);                       // tokenOut, must be 18dp (band pins it)
  const feed = await deployFeed(c, ORACLE_ANSWER);            // 8dp controllable Chainlink mock
  const account = await deployAccount(c, c.ops.address as Hex, sessionAcct.address as Hex, asset);
  const fund = await c.wallet.sendTransaction({ to: sessionAcct.address, value: 20_000_000_000_000_000n }); // 0.02 ETH gas
  await c.pub.waitForTransactionReceipt({ hash: fund });
  const router = await deployMockRouter(c);
  console.log(`account=${account}  router(mock)=${router}\nfeed(8dp)=${feed}  asset(18dp,tokenOut)=${asset}`);

  // ARM: swap call-rule on (router, SEL_SWAP), fund the spend budget, set the price band, latch require-band.
  await armCallRule(c, account, router, perCallCap, windowCapCall);
  await setBudget(c, account, tokenIn, budgetWindowCap);
  await armPriceBand(c, account, router, feed, asset, MAX_DEV_BPS, MAX_STALENESS);

  const self = account;
  const cd = (out: bigint) => swapCalldata(tokenIn, asset, amountIn, out, self); // recipient=self (passes recip wall)

  // (a) IN-BAND — fresh feed, implied ≤ maxPrice → wall passes (router runs)
  await feedSetAnswer(c, feed, ORACLE_ANSWER);
  const a = await sessionExecuteCall(c, sessionWallet, account, router, cd(outInBand), sessionAcct.address as Hex);

  // (b) PREMIUM BREACH — fresh feed, amountOutMin too small ⇒ implied > maxPrice → PremiumBreach
  await feedSetAnswer(c, feed, ORACLE_ANSWER);
  const b = await sessionExecuteCall(c, sessionWallet, account, router, cd(outPremium), sessionAcct.address as Hex);

  // (c) STALE ORACLE — updatedAt pushed 2h back (> 1h maxStaleness) → StaleOracle
  await feedSetAnswer(c, feed, ORACLE_ANSWER);
  await feedSetStale(c, feed, 7200n);
  const cc = await sessionExecuteCall(c, sessionWallet, account, router, cd(outInBand), sessionAcct.address as Hex);

  // (d) INVALID PRICE — answer set to 0 (answer <= 0) → OraclePriceInvalid
  await feedSetAnswer(c, feed, 0n);
  const d = await sessionExecuteCall(c, sessionWallet, account, router, cd(outInBand), sessionAcct.address as Hex);

  // ─── assertions (on receipt.status + decoded revert name, NOT thrown errors) ───
  const BAND_ERRORS = ['PremiumBreach', 'StaleOracle', 'OraclePriceInvalid', 'OracleCallFailed', 'PriceBandAssetMismatch', 'BandRequired'];
  const aOk = a.status === 'success' || !BAND_ERRORS.includes(a.errorName);   // wall passes (not a band error)
  const bOk = b.status === 'reverted' && b.errorName === 'PremiumBreach';
  const cOk = cc.status === 'reverted' && cc.errorName === 'StaleOracle';
  const dOk = d.status === 'reverted' && d.errorName === 'OraclePriceInvalid';

  console.log('\n=== RH2 V5 PRICE-BAND WALL — LIVE MATRIX ===');
  console.log(`(a) in-band       → status=${a.status} err=${a.errorName || '-'}  ${aOk ? 'wall passes ✅' : '❌'}  tx=${a.txHash.slice(0, 10)}..`);
  console.log(`(b) premium       → status=${b.status} err=${b.errorName || '-'}  ${bOk ? 'PremiumBreach ✅' : '❌'}  tx=${b.txHash.slice(0, 10)}..`);
  console.log(`(c) stale oracle  → status=${cc.status} err=${cc.errorName || '-'}  ${cOk ? 'StaleOracle ✅' : '❌'}  tx=${cc.txHash.slice(0, 10)}..`);
  console.log(`(d) invalid price → status=${d.status} err=${d.errorName || '-'}  ${dOk ? 'OraclePriceInvalid ✅' : '❌'}  tx=${d.txHash.slice(0, 10)}..`);
  console.log('\nThis proves the V5 price-band WALL: the price-ratio guard (implied swap price bounded to oracle*(1+bps), PremiumBreach) + the oracle-health guards (StaleOracle on a stale feed, OraclePriceInvalid on answer<=0) — the V4 capability-hero equivalent, now live on V5.');

  const allOk = aOk && bOk && cOk && dOk;
  console.log(allOk ? '\nPRICE-BAND WALL PROVEN ON V5 ✅' : '\nFAILURES PRESENT ❌');
  process.exit(allOk ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(1); });
