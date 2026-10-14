/**
 * WAVE-1 TEAR-APART — LIVE on-chain proof of two load-bearing trust walls, driven ADVERSARIALLY
 * (fresh receipts, not citations). Model: the stolen-key attacker holds a raw EOA and submits
 * directly to a DEPLOYED V5 account. The contract is the terminal authority — it must reject.
 *
 * Deploys a FRESH V5 on Ethereum Sepolia where:
 *   owner    = victim random EOA   (NOT ops — this is the whole A1 point)
 *   guardian = victim random EOA
 *   session  = session random EOA  (the runtime's key; "hijacked" in PP-3)
 *   ops      = deployer + gas payer ONLY (holds no role on the deployed account)
 * perTransferCap = 1 wei, perTransferCapToken = 5, settlementToken = tokenA.
 *
 * A1 — STOLEN OPS KEY has ZERO authority on a deployed account. Ops attempts:
 *   execute / executeTokenTransfer      → NotSessionKey  (ops is not the session key)
 *   proposePolicy / proposeAllowlist / setGuardian → NotOwner (ops is not the owner)
 *
 * PP-3 — SOFT IS NEVER LOAD-BEARING. The session key (layer-1 fully defeated, max-malicious)
 * attempts, with NO off-chain gate in the path:
 *   execute(self, 2 wei)                → OverPerTransferCap        (2 > cap 1)
 *   executeTokenTransfer(tokenB, …, 1)  → TokenNotAllowlisted       (tokenB != settlementToken)
 *   executeTokenTransfer(tokenA, …, 6)  → OverPerTransferCapToken   (6 > cap 5)
 *
 * Every revert is asserted on receipt.status==reverted + decodeErrorResult against the COMPILED
 * V5 artifact ABI ([[validate-diagnostic-probe-first]] — no hand-written selector).
 *
 * Run:  npx tsx scripts/tearapart/wave1-a1-pp3-walls-live.mts
 * SPENDS real Ethereum-Sepolia gas (ops pays). Fresh account each run.
 */
import { readFileSync } from 'node:fs';
import {
  createPublicClient, createWalletClient, http, defineChain,
  encodeFunctionData, decodeErrorResult, getAddress,
  type Hex, type Abi,
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
  return JSON.parse(readFileSync(new URL(`../../../contracts/out/${name}.sol/${name}.json`, import.meta.url), 'utf8')) as {
    abi: Abi; bytecode: { object: Hex };
  };
}
const artifact = loadArtifact('LeashAccountV5');
const SIGNING_HELPER = env('LEASH_SIGNING_HELPER_ADDR') as Hex;
const DECODE_HELPER = env('LEASH_DECODE_HELPER_ADDR') as Hex;
const SPEC = { name: 'Ethereum Sepolia', chainId: 11155111, rpcEnv: 'ETHEREUM_SEPOLIA_RPC' };

function ctx() {
  const rpc = env(SPEC.rpcEnv);
  const opsRaw = env('OPS_PRIVATE_KEY');
  const ops = privateKeyToAccount((opsRaw.startsWith('0x') ? opsRaw : `0x${opsRaw}`) as Hex);
  const chain = defineChain({ id: SPEC.chainId, name: SPEC.name, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const wallet = createWalletClient({ chain, transport: http(rpc), account: ops });
  return { rpc, ops, chain, pub, wallet };
}
type Ctx = ReturnType<typeof ctx>;

function revertErrorName(data: Hex | undefined): string {
  if (!data || data === '0x' || data.length < 10) return '';
  try { return decodeErrorResult({ abi: artifact.abi, data }).errorName; } catch { return ''; }
}

type Outcome = { status: 'success' | 'reverted'; errorName: string; txHash: Hex };

/** Generic adversarial attempt: `from` sends a V5 call with explicit gas (revert ⇒ status==0,
 *  no throw); first eth_call to recover+decode the revert selector against the artifact ABI. */
async function attempt(
  c: Ctx, fromWallet: ReturnType<typeof createWalletClient>, fromAddr: Hex,
  account: Hex, functionName: string, args: readonly unknown[],
): Promise<Outcome> {
  const data = encodeFunctionData({ abi: artifact.abi, functionName, args });
  let errorName = '';
  try {
    await c.pub.call({ account: fromAddr, to: account, data });
  } catch (err) {
    const raw = (err as { walk?: (fn: (e: unknown) => boolean) => unknown }).walk?.((e) => (e as { data?: unknown }).data !== undefined) as { data?: Hex } | undefined;
    errorName = revertErrorName(raw?.data);
  }
  const txHash = await fromWallet.sendTransaction({ chain: c.chain, to: account, data, gas: 400_000n } as never);
  const rc = await c.pub.waitForTransactionReceipt({ hash: txHash });
  return { status: rc.status, errorName, txHash };
}

async function run(): Promise<void> {
  const c = ctx();
  const ownerAcct = privateKeyToAccount(generatePrivateKey());   // victim owner — ops is NOT this
  const guardianAcct = privateKeyToAccount(generatePrivateKey());
  const sessionAcct = privateKeyToAccount(generatePrivateKey()); // runtime key (hijacked in PP-3)
  const sessionWallet = createWalletClient({ chain: c.chain, transport: http(c.rpc), account: sessionAcct });

  const tokenA = getAddress('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238') as Hex; // settlementToken
  const tokenB = getAddress('0x779877A7B0D9E8603169DdbD7836e478b4624789') as Hex; // NOT allowlisted
  const sink = getAddress('0x000000000000000000000000000000000000dEaD') as Hex;   // allowlisted recipient
  const sink2 = getAddress('0x000000000000000000000000000000000000bEEF') as Hex;  // NOT allowlisted

  const nowSec = Math.floor(Date.now() / 1000);
  const policy = { perTransferCap: 1n, windowCap: 1000n, windowSeconds: 3600, expiresAt: BigInt(nowSec + 365 * 24 * 3600) };
  const tokenPolicy = { perTransferCapToken: 5n, windowCapToken: 1000n };

  console.log(`\n[${SPEC.name}]  owner(victim)=${ownerAcct.address}  session=${sessionAcct.address}  ops(attacker)=${c.ops.address}`);

  // Deploy FRESH V5 (ops pays gas but is neither owner nor session).
  const dh = await c.wallet.deployContract({
    abi: artifact.abi, bytecode: artifact.bytecode.object,
    // sink pre-allowlisted so PP-3's cap attempts pass the recipient-allowlist and trip the CAP
    // wall specifically (the layered allowlist-before-cap ordering is itself a wall — proven separately below).
    args: [ownerAcct.address, guardianAcct.address, sessionAcct.address, policy, [sink], 0n, tokenA, tokenPolicy, SIGNING_HELPER, DECODE_HELPER],
  });
  const drc = await c.pub.waitForTransactionReceipt({ hash: dh });
  const account = drc.contractAddress as Hex;
  // Fund the session EOA for gas (so its adversarial attempts can be submitted).
  await c.pub.waitForTransactionReceipt({ hash: await c.wallet.sendTransaction({ to: sessionAcct.address, value: 20_000_000_000_000_000n }) });
  console.log(`account=${account}  (perTransferCap=1 wei, perTransferCapToken=5, settlementToken=tokenA)\n`);

  // ── A1: stolen ops key (c.wallet) attempts privileged calls → must all revert ──
  const a_exec = await attempt(c, c.wallet, c.ops.address as Hex, account, 'execute', [sink, 1n, '0x']);
  const a_tok  = await attempt(c, c.wallet, c.ops.address as Hex, account, 'executeTokenTransfer', [tokenA, sink, 1n]);
  const a_pol  = await attempt(c, c.wallet, c.ops.address as Hex, account, 'proposePolicy', [{ perTransferCap: 10n ** 30n, windowCap: 10n ** 30n, windowSeconds: 3600, expiresAt: BigInt(nowSec + 999999) }]);
  const a_allow= await attempt(c, c.wallet, c.ops.address as Hex, account, 'proposeAllowlist', [sink]);
  const a_guard= await attempt(c, c.wallet, c.ops.address as Hex, account, 'setGuardian', [c.ops.address]);

  // ── PP-3: hijacked session key attempts max-malicious money moves → must all revert ──
  const p_over = await attempt(c, sessionWallet, sessionAcct.address as Hex, account, 'execute', [sink, 2n, '0x']);                 // allowlisted recip, 2 > cap 1
  const p_badR = await attempt(c, sessionWallet, sessionAcct.address as Hex, account, 'execute', [sink2, 1n, '0x']);               // non-allowlisted recip
  const p_badT = await attempt(c, sessionWallet, sessionAcct.address as Hex, account, 'executeTokenTransfer', [tokenB, sink, 1n]);  // wrong token
  const p_overT= await attempt(c, sessionWallet, sessionAcct.address as Hex, account, 'executeTokenTransfer', [tokenA, sink, 6n]);  // 6 > cap 5

  const rows: Array<[string, Outcome, string]> = [
    ['A1  ops.execute',                a_exec,  'NotSessionKey'],
    ['A1  ops.executeTokenTransfer',   a_tok,   'NotSessionKey'],
    ['A1  ops.proposePolicy',          a_pol,   'NotOwner'],
    ['A1  ops.proposeAllowlist',       a_allow, 'NotOwner'],
    ['A1  ops.setGuardian',            a_guard, 'NotOwner'],
    ['PP3 session.execute over-cap',   p_over,  'OverPerTransferCap'],
    ['PP3 session.execute bad-recip',  p_badR,  'NotAllowlisted'],
    ['PP3 session.tokenXfer wrong-tok',p_badT,  'TokenNotAllowlisted'],
    ['PP3 session.tokenXfer over-cap', p_overT, 'OverPerTransferCapToken'],
  ];
  console.log('=== WAVE-1 A1 + PP-3 — LIVE WALL MATRIX ===');
  let allOk = true;
  for (const [label, o, want] of rows) {
    const ok = o.status === 'reverted' && o.errorName === want;
    allOk &&= ok;
    console.log(`${ok ? '✅' : '❌'} ${label.padEnd(34)} → status=${o.status} err=${o.errorName || '-'} (want ${want}) tx=${o.txHash.slice(0, 12)}..`);
  }
  console.log(`\nA1: a stolen ops/deployer key has ZERO authority on a DEPLOYED account (owner≠ops, session≠ops) — every privileged call reverts.`);
  console.log(`PP-3: a fully-hijacked session key (layer-1 defeated) is stopped by the on-chain cap/allowlist wall alone — zero off-chain gate in the path.`);
  console.log(allOk ? '\nBOTH WALLS HOLD LIVE ✅' : '\nFAILURES PRESENT ❌');
  process.exit(allOk ? 0 : 1);
}
run().catch((e) => { console.error(e); process.exit(1); });
