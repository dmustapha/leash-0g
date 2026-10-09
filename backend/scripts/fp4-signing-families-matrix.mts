/**
 * Stage F′ FP-4 CLOSE-OUT — LIVE SIGNING-INTENT RE-PROOF for all THREE governed-signing families.
 *
 * Proves, end-to-end on a live testnet, that the REDEPLOYED on-chain SigningLib (STEP 1, the 7,021 B
 * Slice-4/5 build at the pinned address) validates each family's armed intent via ERC-1271:
 *   1. co-signer second factor (Slice-2)  — standard permit2 intent, armed WITH a co-signer approval sig;
 *      also proves the factor is LOAD-BEARING (an empty co-signer sig REVERTS BadCoSignerSignature).
 *   2. CoW GPv2Order (Slice-4)            — order-kind intent (no spender role), armed, isValidSignature==magic.
 *   3. Permit2 PermitBatchTransferFrom (Slice-5) — batch-kind intent, caps submitted at arm, per-token debit.
 *
 * Each family uses a FRESH V5 account deployed with timelockDelay=0, wired to the PINNED SigningLib +
 * DecodeLib from backend/.env (so the proof exercises the exact on-chain helper STEP 1 redeployed — NOT a
 * throwaway). Default chain = Ethereum Sepolia (the seeded home for order id30 + batch id40).
 *
 * Run: `npx tsx scripts/fp4-signing-families-matrix.mts [chainKey...]`. SPENDS real testnet gas (owner-
 * authorized). Uses the FULL Foundry artifact ABI (the hand-maintained src/chain/abis.ts is caps-stale).
 */
import { readFileSync } from 'node:fs';
import {
  createPublicClient, createWalletClient, http, defineChain, keccak256, encodeAbiParameters,
  type Hex, type Abi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { defaultSigningRegistry, onChainGrantParams, buildIntent, buildBatchIntent, type SigningRule } from '../src/signing/index.js';

const ERC1271_MAGIC = '0x1626ba7e';
const COSIGNER_APPROVAL_TYPEHASH = keccak256(
  new TextEncoder().encode('CoSignerApproval(bytes32 intentDigest,uint256 chainId,address account,uint64 epoch)'),
);

function env(key: string): string {
  if (process.env[key]) return process.env[key] as string;
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const t = line.trim();
    if (t.startsWith(`${key}=`)) return t.slice(key.length + 1).replace(/^"|"$/g, '');
  }
  throw new Error(`missing ${key} in backend/.env`);
}

function loadArtifact(name: string): { abi: Abi; bytecode: { object: Hex } } {
  return JSON.parse(readFileSync(new URL(`../../contracts/out/${name}.sol/${name}.json`, import.meta.url), 'utf8')) as {
    abi: Abi; bytecode: { object: Hex };
  };
}
const artifact = loadArtifact('LeashAccountV5');

const SIGNING_HELPER = env('LEASH_SIGNING_HELPER_ADDR') as Hex;
const DECODE_HELPER = env('LEASH_DECODE_HELPER_ADDR') as Hex;
const SPENDER = '0x1111111111111111111111111111111111111111' as Hex;
const SEPOLIA_WETH = '0xfff9976782d46cc05630d1f6ebab18b2324d6b14' as Hex;
const SEPOLIA_USDC = (defaultSigningRegistry.byKey('permit2.batch.eth')?.tokenCaps?.[0]?.token ?? '') as Hex;

interface ChainSpec { key: string; name: string; chainId: number; rpcEnv: string }
const CHAINS: ChainSpec[] = [
  { key: 'eth', name: 'Ethereum Sepolia', chainId: 11155111, rpcEnv: 'ETHEREUM_SEPOLIA_RPC' },
];

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

/** Deploy a fresh V5 wired to the PINNED helpers; timelockDelay=0 ⇒ instant grant/budget apply. */
async function deployAccount(c: Ctx, session: Hex, settlementToken: Hex): Promise<Hex> {
  const nowSec = Math.floor(Date.now() / 1000);
  const policy = { perTransferCap: 0n, windowCap: 0n, windowSeconds: 3600, expiresAt: BigInt(nowSec + 365 * 24 * 3600) };
  const hash = await c.wallet.deployContract({
    abi: artifact.abi, bytecode: artifact.bytecode.object,
    args: [c.ops.address, c.ops.address, session, policy, [], 0n, settlementToken, { perTransferCapToken: 0n, windowCapToken: 0n }, SIGNING_HELPER, DECODE_HELPER],
  });
  const rc = await c.pub.waitForTransactionReceipt({ hash });
  if (!rc.contractAddress) throw new Error('no contract address');
  return rc.contractAddress;
}

function grantStruct(p: ReturnType<typeof onChainGrantParams>, token: Hex, perIntentCap: bigint) {
  return {
    descriptorId: BigInt(p.descriptorId), domainSeparator: p.domainSeparator, typeHash: p.typeHash,
    numTopFields: p.numFields, spenderLeafIndex: p.spenderIndex, amountLeafIndex: p.amountIndex,
    deadlineLeafIndex: p.deadlineIndex, expiryLeafIndex: p.expiryLeafIndex, nestedTypeHash: p.nestedTypeHash,
    nestedLeafStart: p.nestedLeafStart, nestedLeafCount: p.nestedLeafCount, token, perIntentCap,
    maxDeadlineWindow: 3600n, kind: p.kind, buyToken: p.buyToken,
  };
}

async function proposeApplyGrant(c: Ctx, account: Hex, struct: object, spenders: Hex[], caps: { token: Hex; cap: bigint }[]) {
  const ph = await c.wallet.writeContract({ address: account, abi: artifact.abi, functionName: 'proposeSigningGrantNested', args: [struct, spenders, caps] });
  if ((await c.pub.waitForTransactionReceipt({ hash: ph })).status !== 'success') throw new Error('propose reverted');
  await pollRead(() => c.pub.readContract({ address: account, abi: artifact.abi, functionName: 'pendingSigningGrant', args: [] }) as Promise<unknown[]>, (v) => BigInt((v[10] as bigint) ?? 0n) !== 0n);
  const ah = await c.wallet.writeContract({ address: account, abi: artifact.abi, functionName: 'applySigningGrant', args: [] });
  if ((await c.pub.waitForTransactionReceipt({ hash: ah })).status !== 'success') throw new Error('apply reverted');
}

async function setBudget(c: Ctx, account: Hex, token: Hex, windowCap: bigint) {
  const ph = await c.wallet.writeContract({ address: account, abi: artifact.abi, functionName: 'proposeSpendBudget', args: [token, windowCap] });
  if ((await c.pub.waitForTransactionReceipt({ hash: ph })).status !== 'success') throw new Error('proposeSpendBudget reverted');
  const ah = await c.wallet.writeContract({ address: account, abi: artifact.abi, functionName: 'applySpendBudget', args: [] });
  if ((await c.pub.waitForTransactionReceipt({ hash: ah })).status !== 'success') throw new Error('applySpendBudget reverted');
}

async function verifyMagic(c: Ctx, account: Hex, digest: Hex): Promise<boolean> {
  const magic = await pollRead(() => c.pub.readContract({ address: account, abi: artifact.abi, functionName: 'isValidSignature', args: [digest, '0x'] }) as Promise<Hex>, (v) => v.toLowerCase() === ERC1271_MAGIC);
  return magic.toLowerCase() === ERC1271_MAGIC;
}

async function coSignerSign(coSigner: ReturnType<typeof privateKeyToAccount>, digest: Hex, chainId: number, account: Hex, epoch: bigint): Promise<Hex> {
  const approvalHash = keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint64' }],
    [COSIGNER_APPROVAL_TYPEHASH, digest, BigInt(chainId), account, epoch],
  ));
  return coSigner.sign({ hash: approvalHash });
}

// ───────────────────── Family 1: co-signer second factor (standard permit2) ─────────────────────
async function famCoSigner(c: Ctx, spec: ChainSpec): Promise<string> {
  // Use OPS as the session key: the arm only needs msg.sender==sessionKey, and ops is already funded +
  // RPC-visible — this sidesteps the public-RPC's unreliable funding of a fresh session EOA entirely.
  const session = c.ops;
  const coSignerPk = `0xc0${'0c'.repeat(31)}` as Hex; const coSigner = privateKeyToAccount(coSignerPk);
  const d = defaultSigningRegistry.byKey('permit2.single.eth')!; const p = onChainGrantParams(d);
  const token = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as Hex;
  const account = await deployAccount(c, session.address, token);
  // set the co-signer (instant-add) + grant.
  const sc = await c.wallet.writeContract({ address: account, abi: artifact.abi, functionName: 'setCoSigner', args: [coSigner.address] });
  if ((await c.pub.waitForTransactionReceipt({ hash: sc })).status !== 'success') throw new Error('setCoSigner reverted');
  await proposeApplyGrant(c, account, grantStruct(p, token, 1_000_000_000_000n), [SPENDER], []);
  const rule: SigningRule = { descriptorId: p.descriptorId, spenderSet: [SPENDER], perIntentCap: '1000000000000', maxDeadlineWindow: 3600, token, active: true };
  const nowSec = Math.floor(Date.now() / 1000);
  const built = buildIntent(d, rule, { amountWei: '0', spender: SPENDER, ctx: { self: account, nowSec, windowSec: 1800, pins: { nonce: 0, token } } });
  if (!built.ok) throw new Error(`buildIntent: ${built.reason}`);
  const sw = createWalletClient({ chain: c.chain, transport: http(c.rpc), account: session });
  const sessionSig = await session.sign({ hash: built.digest });
  // (a) NEGATIVE: empty co-signer sig MUST revert (factor is load-bearing). Pure eth_call — no gas/tx.
  let reverted = false;
  try {
    await c.pub.simulateContract({ account: session.address, address: account, abi: artifact.abi, functionName: 'authorizeSigningIntent', args: [BigInt(p.descriptorId), built.fields, [], sessionSig, '0x'] });
  } catch { reverted = true; }
  if (!reverted) throw new Error('SECURITY: arm with EMPTY co-signer sig did NOT revert');
  // (b) POSITIVE: valid co-signer approval sig arms — binds the CURRENT on-chain signingEpoch (SR-3).
  const epoch = await c.pub.readContract({ address: account, abi: artifact.abi, functionName: 'signingEpoch', args: [] }) as bigint;
  const coSig = await coSignerSign(coSigner, built.digest, spec.chainId, account, epoch);
  const arm = await sw.writeContract({ address: account, abi: artifact.abi, functionName: 'authorizeSigningIntent', args: [BigInt(p.descriptorId), built.fields, [], sessionSig, coSig] });
  if ((await c.pub.waitForTransactionReceipt({ hash: arm })).status !== 'success') throw new Error('arm reverted');
  if (!(await verifyMagic(c, account, built.digest))) throw new Error('isValidSignature != magic');
  return `account=${account} coSigner=${coSigner.address.slice(0, 10)}.. emptySigReverts=✅ digest=${built.digest.slice(0, 10)}.. ERC-1271 ✅`;
}

// ───────────────────── Family 2: CoW GPv2Order ─────────────────────
async function famOrder(c: Ctx, _spec: ChainSpec): Promise<string> {
  const session = c.ops; // ops-as-session (see famCoSigner) — no fresh-EOA funding needed.
  const d = defaultSigningRegistry.byKey('cow.order.eth')!; const p = onChainGrantParams(d);
  const account = await deployAccount(c, session.address, SEPOLIA_WETH);
  await proposeApplyGrant(c, account, grantStruct(p, SEPOLIA_WETH, 100_000_000_000_000_000_000n), [], []);
  await setBudget(c, account, SEPOLIA_WETH, 10_000_000_000_000_000_000n); // 10 WETH window cap
  const rule: SigningRule = { descriptorId: p.descriptorId, spenderSet: [], perIntentCap: '100000000000000000000', maxDeadlineWindow: 3600, token: SEPOLIA_WETH, active: true };
  const nowSec = Math.floor(Date.now() / 1000);
  const built = buildIntent(d, rule, { amountWei: '1000000000000000', ctx: { self: account, nowSec, windowSec: 1800, pins: { buyAmount: 1n } } });
  if (!built.ok) throw new Error(`buildIntent(order): ${built.reason}`);
  const sw = createWalletClient({ chain: c.chain, transport: http(c.rpc), account: session });
  const sessionSig = await session.sign({ hash: built.digest });
  const arm = await sw.writeContract({ address: account, abi: artifact.abi, functionName: 'authorizeSigningIntent', args: [BigInt(p.descriptorId), built.fields, [], sessionSig, '0x'] });
  if ((await c.pub.waitForTransactionReceipt({ hash: arm })).status !== 'success') throw new Error('arm reverted');
  if (!(await verifyMagic(c, account, built.digest))) throw new Error('isValidSignature != magic');
  return `account=${account} kind=order(no-spender) digest=${built.digest.slice(0, 10)}.. ERC-1271 ✅`;
}

// ───────────────────── Family 3: Permit2 PermitBatchTransferFrom ─────────────────────
async function famBatch(c: Ctx, _spec: ChainSpec): Promise<string> {
  const session = c.ops; // ops-as-session (see famCoSigner) — no fresh-EOA funding needed.
  const d = defaultSigningRegistry.byKey('permit2.batch.eth')!; const p = onChainGrantParams(d);
  const caps = p.tokenCaps.map((cp) => ({ token: cp.token as Hex, cap: BigInt(cp.cap) }));
  const account = await deployAccount(c, session.address, SEPOLIA_USDC);
  await proposeApplyGrant(c, account, grantStruct(p, SEPOLIA_USDC, 0n), [SPENDER], caps);
  await setBudget(c, account, SEPOLIA_USDC, 1_000_000_000n);          // 1,000 USDC
  await setBudget(c, account, SEPOLIA_WETH, 1_000_000_000_000_000_000n); // 1 WETH
  const rule: SigningRule = { descriptorId: p.descriptorId, spenderSet: [SPENDER], perIntentCap: '0', maxDeadlineWindow: 3600, token: SEPOLIA_USDC, tokenCaps: p.tokenCaps.map((cp) => ({ token: cp.token, cap: cp.cap.toString() })), active: true };
  const nowSec = Math.floor(Date.now() / 1000);
  const built = buildBatchIntent(d, rule, { permits: [{ token: SEPOLIA_USDC, amountWei: '500000000' }, { token: SEPOLIA_WETH, amountWei: '250000000000000000' }], ctx: { nowSec, windowSec: 1800, nonce: 7 } });
  if (!built.ok) throw new Error(`buildBatchIntent: ${built.reason}`);
  const sw = createWalletClient({ chain: c.chain, transport: http(c.rpc), account: session });
  const sessionSig = await session.sign({ hash: built.digest });
  const arm = await sw.writeContract({ address: account, abi: artifact.abi, functionName: 'authorizeSigningIntent', args: [BigInt(p.descriptorId), built.fields, caps, sessionSig, '0x'] });
  if ((await c.pub.waitForTransactionReceipt({ hash: arm })).status !== 'success') throw new Error('arm reverted');
  if (!(await verifyMagic(c, account, built.digest))) throw new Error('isValidSignature != magic');
  return `account=${account} kind=batch(2 tokens) capsHash=${(p.tokenCapsHash as string).slice(0, 10)}.. digest=${built.digest.slice(0, 10)}.. ERC-1271 ✅`;
}

const selected = process.argv.slice(2);
const chains = selected.length ? CHAINS.filter((c) => selected.includes(c.key)) : CHAINS;
const results: Record<string, string> = {};
for (const spec of chains) {
  const c = ctx(spec);
  console.log(`\n[${spec.name}]  SigningLib=${SIGNING_HELPER}  DecodeLib=${DECODE_HELPER}`);
  for (const [name, fn] of [['co-signer', famCoSigner], ['cow-order', famOrder], ['permit2-batch', famBatch]] as const) {
    // The public Eth-Sepolia RPC is load-balanced across replicas that lag read-after-write; a flaky
    // pre-check (stale 0-balance / transient revert) resolves on a retry with a fresh account.
    let lastErr = '';
    let ok = false;
    for (let attempt = 1; attempt <= 4 && !ok; attempt++) {
      try {
        const detail = await fn(c, spec);
        results[`${spec.name}/${name}`] = detail;
        console.log(`✅ ${name}: ${detail}`);
        ok = true;
      } catch (err) {
        lastErr = err instanceof Error ? err.message.split('\n')[0] : String(err);
        console.log(`   …${name} attempt ${attempt} failed (${lastErr}) — retrying`);
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
    if (!ok) {
      results[`${spec.name}/${name}`] = `❌ ${lastErr}`;
      console.log(`❌ ${name}: ${lastErr}`);
    }
  }
}
console.log('\n=== FP-4 CLOSE-OUT — 3-FAMILY LIVE SIGNING RE-PROOF ===');
for (const [k, v] of Object.entries(results)) console.log(`${k}: ${v}`);
const allOk = Object.values(results).every((d) => !d.startsWith('❌'));
console.log(allOk ? '\nALL FAMILIES ✅' : '\nFAILURES PRESENT ❌');
process.exit(allOk ? 0 : 1);
