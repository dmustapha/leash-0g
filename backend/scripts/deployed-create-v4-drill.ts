// SE-1 E-2 [DEPLOY] drill — a PRODUCTION-PATH-created V4 account on 0G accepts a
// governed executeCall and refuses an off-allowlist call, proving governed
// calldata is reachable through the REAL create wire (LeashChainOps.
// deployAndRegister with accountVersion:4), not just a hand-deployed account.
//
// Run: cd backend && npx tsx scripts/deployed-create-v4-drill.ts
// Reads backend/.env (ZERO_G_RPC, OPS_PRIVATE_KEY, GUARDIAN_PRIVATE_KEY,
// AGENT_REGISTRY_ADDR). LEASH_FACTORY_V4_ADDR defaults to the deployed 0G factory.
// Idempotent: creates a FRESH account each run (baseline-reset by construction —
// a new account has no rules, so the off-allowlist assertion needs no teardown).
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
import { leashAccountV4Abi, factoryV4Abi } from '../src/chain/abis.js';
import { confirmReceipt, isFlake } from './drill-common.js';

const env: Record<string, string> = {};
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const t = line.trim();
  if (t && !t.startsWith('#') && t.includes('=')) {
    const i = t.indexOf('=');
    env[t.slice(0, i)] = t.slice(i + 1);
  }
}

const RPC = env.ZERO_G_RPC;
const CHAIN_ID = Number(env.ZERO_G_CHAIN_ID ?? '16602');
const V4_FACTORY = (env.LEASH_FACTORY_V4_ADDR ?? '0x70673e447cbe7b11b5193bdb047677ce29eccf8c') as Hex;
const REGISTRY = env.AGENT_REGISTRY_ADDR as Hex;
// Deployed Stage-D mocks on 0G 16602 (docs/DEPLOYMENTS.md / STAGE-D-DEPLOY-RESULTS).
const TUSD = getAddress('0x4E51f90C8Cf60307E01A6abF555762e69Ef0eC2A');
const ROUTER = getAddress('0x425B8638e1B851486F397715EA414d52A1Ab7a65');
// A known-good deployed V4 account — its runtime bytecode is the wall oracle.
const KNOWN_V4 = getAddress('0x2FDbfa0e76D4dC455C95C4e7d445595E714cDCDF');
const APPROVE_SEL = toFunctionSelector('approve(address,uint256)');

const ops = privateKeyToAccount(env.OPS_PRIVATE_KEY as Hex);
const pub = createPublicClient({ transport: http(RPC) });
const wallet = createWalletClient({ account: ops, transport: http(RPC) });

let pass = 0;
let fail = 0;
const results: Array<{ check: string; ok: boolean; detail: string }> = [];
function record(check: string, ok: boolean, detail: string) {
  results.push({ check, ok, detail });
  if (ok) { pass++; console.log(`pass  ${check} — ${detail}`); }
  else { fail++; console.log(`FAIL  ${check} — ${detail}`); }
}

// SE-4: bounded RPC-flake tolerance (a transient receipt drop / timeout is retried; a genuine
// revert rethrows). This drill is idempotent by construction — a FRESH account each run, so no
// baseline-reset teardown is needed (a new account has no rules).
async function send(to: Hex, data: Hex): Promise<Hex> {
  const hash = await wallet.sendTransaction({ chain: null, to, data, gas: 400_000n });
  await confirmReceipt(pub, hash); // re-polls the same hash; tolerates 0G receipt drops, no double-submit
  return hash;
}

async function main() {
  console.log(`SE-1 E-2 drill · chain ${CHAIN_ID} · V4 factory ${V4_FACTORY} · ops ${ops.address}`);

  // (1) Production create wire: mint a fresh V4 through LeashChainOps — owner AND
  // sessionKey = ops (funded), timelockDelay 0 so applyCallRule is immediate.
  const chain = new LeashChainOps({
    rpcUrl: RPC,
    chainId: CHAIN_ID,
    opsPrivateKey: env.OPS_PRIVATE_KEY,
    guardianPrivateKey: env.GUARDIAN_PRIVATE_KEY,
    factoryAddr: env.LEASH_FACTORY_ADDR,
    factoryV4Addr: V4_FACTORY,
    registryAddr: REGISTRY,
  });
  // S4-5 no-resend: deployAndRegister must NOT be wrapped in withFlakeRetry — that
  // re-invokes the WHOLE deploy on a flaked receipt and can mint a DUPLICATE account
  // (the create tx may already be mined). Its internal `waitReceipt` already re-polls
  // the SAME create-tx hash on a 0G receipt-drop (TransactionReceiptNotFoundError /
  // timeout, 4×) without resending anything — that IS the correct transient tolerance.
  // A genuinely failed deploy just fails the drill; SE-4 fresh-account idempotency
  // (a new account each run) makes an external re-run safe with no duplicate reused.
  const deployed = await chain.deployAndRegister({
    ownerAddr: ops.address,
    sessionKeyAddr: ops.address,
    auditPubKey: '04' + 'ab'.repeat(64),
    name: `e2-drill-${Date.now()}`,
    accountVersion: 4,
    policy: { perTransferCap: 10n ** 18n, windowCap: 10n ** 18n, windowSeconds: 3600, expiresAt: 2 ** 31 },
    allowlist: [],
    timelockDelay: 0,
  });
  const account = getAddress(deployed.accountAddr);
  record('production create → V4', deployed.accountVersion === 4, `account=${account} version=${deployed.accountVersion} createTx=${deployed.createTx}`);

  // (2) Genuine V4 bytecode — same runtime-code LENGTH as a known-good deployed
  // V4 account. (owner/settlementToken/timelockDelay are `immutable` → their
  // VALUES differ per account, so full-byte equality is wrong; the length is
  // stable and the executeCall wall is proven live in check 3.)
  const [codeNew, codeKnown] = await Promise.all([
    pub.getCode({ address: account }),
    pub.getCode({ address: KNOWN_V4 }),
  ]);
  record('created account carries the V4 wall bytecode', !!codeNew && codeNew.length === codeKnown?.length, `len=${codeNew?.length} known=${codeKnown?.length}`);

  // (3) Wall LIVE + off-allowlist REFUSED: a governed executeCall to a target
  // with no rule reverts at the true boundary (TargetNotAllowlisted 0x042a9b0d).
  const offData = encodeFunctionData({ abi: leashAccountV4Abi, functionName: 'executeCall', args: [ROUTER, 0n, encodeFunctionData({ abi: [{ name: 'approve', type: 'function', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' }], functionName: 'approve', args: [ROUTER, 1_000_000n] })] });
  let offRefused = false;
  let offDetail = 'call unexpectedly succeeded';
  try {
    await pub.call({ account: ops.address, to: account, data: offData });
  } catch (e) {
    // A transient flake is inconclusive (rethrow → the drill fails and is re-run), never scored
    // as "refused" (SE-4 E-13: the key fix — a flake must not masquerade as the wall's refusal).
    if (isFlake(e)) throw e;
    const msg = String((e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message);
    // A governed call to a NON-allowlisted target can only revert TargetNotAllowlisted — so any
    // genuine (non-flake) revert here IS the refusal. 0G's eth_call does not surface the
    // custom-error selector to viem ("execution reverted for an unknown reason"), so match it
    // opportunistically but accept a generic non-flake revert.
    offRefused = /042a9b0d|TargetNotAllowlisted|execution reverted|revert/i.test(msg);
    offDetail = msg.slice(0, 140);
  }
  record('off-allowlist executeCall REFUSED at the wall', offRefused, offDetail);

  // (4) Governed call ACCEPTED: owner grants an approve rule (spender=router,
  // cap 200e6), applies it (timelock 0), then the sessionKey executeCall lands.
  await send(account, encodeFunctionData({
    abi: leashAccountV4Abi,
    functionName: 'proposeCallRule',
    args: [TUSD, APPROVE_SEL, 0, [ROUTER], 200_000_000n, 200_000_000n, ('0x' + '00'.repeat(32)) as Hex],
  }));
  await send(account, encodeFunctionData({ abi: leashAccountV4Abi, functionName: 'applyCallRule', args: [] }));
  // The shared per-token outflow budget (the spine) — approve debits it, so it
  // must be set before the happy call (D-3). Timelock 0 → applies immediately.
  await send(account, encodeFunctionData({ abi: leashAccountV4Abi, functionName: 'proposeSpendBudget', args: [TUSD, 500_000_000n] }));
  await send(account, encodeFunctionData({ abi: leashAccountV4Abi, functionName: 'applySpendBudget', args: [] }));
  const happyInner = encodeFunctionData({ abi: [{ name: 'approve', type: 'function', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' }], functionName: 'approve', args: [ROUTER, 100_000_000n] });
  const happyTx = await send(account, encodeFunctionData({ abi: leashAccountV4Abi, functionName: 'executeCall', args: [TUSD, 0n, happyInner] }));
  const allowance = (await pub.readContract({ address: TUSD, abi: [{ name: 'allowance', type: 'function', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }], functionName: 'allowance', args: [account, ROUTER] })) as bigint;
  record('governed executeCall ACCEPTED within caps', allowance === 100_000_000n, `allowance=${allowance} happyTx=${happyTx}`);

  const evidence = {
    drill: 'SE-1 E-2 deployed create→V4',
    chainId: CHAIN_ID,
    factoryV4: V4_FACTORY,
    account,
    createTx: deployed.createTx,
    score: `${pass}/${pass + fail}`,
    checks: results,
    at: new Date().toISOString(),
  };
  const out = new URL('../../docs/evidence/stage-e-create-v4-drill.json', import.meta.url);
  writeFileSync(out, JSON.stringify(evidence, null, 2));
  console.log(`\n${pass}/${pass + fail} passed · evidence → docs/evidence/stage-e-create-v4-drill.json`);
  void factoryV4Abi;
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error('drill error:', e); process.exit(1); });
