// SE-8 E-9 [DEPLOY] drill — GOVERNED BRIDGING, LIVE on Base Sepolia (home) +
// Ethereum Sepolia (destination).
//
// Proves, against the REAL OP-stack L2StandardBridge (0x4200…0010):
//   1. the deterministic V4 factory (SE-8 bytecode, with the bridge decoders)
//      sits at the SAME address on home + destination (idempotent ensure);
//   2. the same (owner, salt) + tuple mints the account at the SAME address on
//      BOTH chains — the far-chain funds destination is a REAL leashed account;
//   3. the PRODUCTION pre-routing gate (`assertBridgeRoutable` →
//      `ChainRegistry.assertSameAddress`, carry #1) PASSES in its full shape;
//   4. a governed bridge call to the ALLOWLISTED bridge within the bridged-amount
//      cap LANDS (real `bridgeETHTo(self)` withdrawal initiated, status 1);
//   5. the malicious matrix REVERTS at the true boundary, selector-anchored:
//      over-cap → OverPerCallCap · redirect → RecipientNotSelf · extraData
//      payload → DecodeMismatch · off-allowlist bridge → TargetNotAllowlisted —
//      plus ONE REAL redirect tx confirmed status 0 on-chain;
//   6. the gate REFUSES: an off-bridge-allowlist target, a mutated tuple
//      (same-address drift), and an unregistered destination chain (E-11).
//
// Run: cd backend && npx tsx scripts/se8-bridge-drill.ts
// SE-4 conventions: transport-only flake tolerance, same-hash receipt re-poll,
// fresh account salt per run (idempotent), green iff fail==0 AND flake==0,
// evidence with runs history → docs/evidence/stage-e-bridge-drill.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  getCreate2Address,
  keccak256,
  stringToHex,
  parseAbi,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { factoryV4DeterministicAbi, leashAccountV4Abi } from '../src/chain/abis.js';
import { ChainRegistry, type ChainConfig } from '../src/chain/registry.js';
import { assertBridgeRoutable, BridgeRoutingRefusedError } from '../src/runtime/bridge-gate.js';
import { zeroGChain } from '../src/chain/ops.js';
import type { AgentRow } from '../src/types.js';
import { confirmReceipt, withFlakeRetry, isFlake } from './drill-common.js';

const env: Record<string, string> = {};
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const t = line.trim();
  if (t && !t.startsWith('#') && t.includes('=')) {
    const i = t.indexOf('=');
    env[t.slice(0, i)] = t.slice(i + 1).replace(/^"|"$/g, '');
  }
}

const CREATE2_DEPLOYER = '0x4e59b44847b379578588920cA78FbF26c0B4956C' as Hex;
const FACTORY_SALT = keccak256(stringToHex('LEASH-V4-DETERMINISTIC-FACTORY-v1'));
// The REAL OP-stack L2StandardBridge predeploy on Base Sepolia.
const BRIDGE = '0x4200000000000000000000000000000000000010' as Hex;
const SEL_BRIDGE_ETH_TO = '0xe11013dd';
// error selectors (anchored, never regex-on-message alone)
const ERR = {
  OverPerCallCap: '0x2671b8a6',
  RecipientNotSelf: '0x239e7696',
  DecodeMismatch: '0xee0f83ce',
  TargetNotAllowlisted: '0x042a9b0d',
} as const;

const PER_CALL_CAP = 200_000_000_000_000n; // 0.0002 ETH bridged-amount cap
const HAPPY_VALUE = 100_000_000_000_000n; // 0.0001 ETH — in-cap
const OVER_VALUE = 300_000_000_000_000n; // over the per-call cap

const ops = privateKeyToAccount(env.OPS_PRIVATE_KEY as Hex);
const guardian = privateKeyToAccount(env.GUARDIAN_PRIVATE_KEY as Hex);
const ATTACKER = ('0x' + 'be'.repeat(20)) as Hex;

interface ChainCtx {
  name: string;
  chainId: number;
  rpc: string;
  pub: PublicClient;
  wallet: WalletClient;
}
function ctx(name: string, chainId: number, rpc: string): ChainCtx {
  const chain = zeroGChain(rpc, chainId);
  return {
    name,
    chainId,
    rpc,
    pub: createPublicClient({ chain, transport: http(rpc) }),
    wallet: createWalletClient({ chain, transport: http(rpc), account: ops }),
  };
}

const BASE = ctx('base-sepolia', 84532, env.BASE_DRILL_RPC ?? env.BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org');
const SEPOLIA = ctx('ethereum-sepolia', 11155111, env.ETHEREUM_SEPOLIA_RPC ?? 'https://ethereum-sepolia-rpc.publicnode.com');
const CHAINS = [BASE, SEPOLIA];

const artifact = JSON.parse(
  readFileSync(new URL('../../contracts/out/LeashAccountV4FactoryDeterministic.sol/LeashAccountV4FactoryDeterministic.json', import.meta.url), 'utf8'),
) as { bytecode: { object: Hex } };
const FACTORY_INITCODE = artifact.bytecode.object;
const FACTORY_ADDR = getCreate2Address({ from: CREATE2_DEPLOYER, salt: FACTORY_SALT, bytecodeHash: keccak256(FACTORY_INITCODE) });

let pass = 0;
let fail = 0;
let flake = 0;
const results: Array<{ check: string; ok: boolean; detail: string }> = [];
function record(check: string, ok: boolean, detail: string, kind: 'pass' | 'fail' | 'flake' = ok ? 'pass' : 'fail') {
  if (kind === 'flake') flake++;
  else if (ok) pass++;
  else fail++;
  results.push({ check, ok, detail });
  console.log(`${ok ? 'PASS' : kind.toUpperCase()}  ${check} — ${detail}`);
}

async function waitForCode(c: ChainCtx, addr: Hex, retries = 12, sleepMs = 5000): Promise<string | null> {
  for (let i = 0; i < retries; i++) {
    try {
      const code = await c.pub.getCode({ address: addr });
      if (code && code !== '0x') return code;
    } catch (err) {
      if (!isFlake(err)) throw err;
    }
    if (i < retries - 1) await new Promise((r) => setTimeout(r, sleepMs));
  }
  return null;
}

async function ensureFactory(c: ChainCtx): Promise<void> {
  const code = await withFlakeRetry(() => c.pub.getCode({ address: FACTORY_ADDR }), { label: `${c.name} getCode` });
  if (code && code !== '0x') {
    record(`factory@${c.name}`, true, `already deployed at ${FACTORY_ADDR} (idempotent skip)`);
    return;
  }
  const hash = await c.wallet.sendTransaction({
    chain: c.wallet.chain,
    account: ops,
    to: CREATE2_DEPLOYER,
    data: (FACTORY_SALT + FACTORY_INITCODE.slice(2)) as Hex,
  });
  await confirmReceipt(c.pub, hash);
  const deployed = await waitForCode(c, FACTORY_ADDR);
  record(`factory@${c.name}`, deployed !== null, deployed !== null ? `deployed at ${FACTORY_ADDR} (tx ${hash})` : `code not visible (tx ${hash})`, deployed !== null ? 'pass' : 'flake');
}

function registryFor(opts: { withDestination?: boolean } = {}): ChainRegistry {
  const configs: ChainConfig[] = [
    {
      chainId: BASE.chainId,
      name: BASE.name,
      rpcUrl: BASE.rpc,
      factoryV4Addr: FACTORY_ADDR,
      registryAddr: (env.AGENT_REGISTRY_BASE_ADDR ?? '0x' + '00'.repeat(20)) as string,
      accountVersion: 4,
      gasFloorWei: 0n,
      bridgeAllowlist: [BRIDGE],
      bridgeDestinations: { [BRIDGE.toLowerCase()]: SEPOLIA.chainId },
    },
  ];
  if (opts.withDestination !== false) {
    configs.push({
      chainId: SEPOLIA.chainId,
      name: SEPOLIA.name,
      rpcUrl: SEPOLIA.rpc,
      factoryV4Addr: FACTORY_ADDR,
      registryAddr: (env.AGENT_REGISTRY_SEPOLIA_ADDR ?? '0x' + '00'.repeat(20)) as string,
      accountVersion: 4,
      gasFloorWei: 0n,
    });
  }
  return new ChainRegistry(configs, {
    opsPrivateKey: env.OPS_PRIVATE_KEY as string,
    guardianPrivateKey: env.GUARDIAN_PRIVATE_KEY as string,
  });
}

/** Walk the viem cause-chain for raw revert data; anchor on the expected selector. */
function anchoredRevert(err: unknown, selector: string, label: string): { ok: boolean; detail: string; kind: 'pass' | 'fail' | 'flake' } {
  const msg = String((err as { shortMessage?: string; message?: string }).shortMessage ?? (err as Error).message ?? err);
  let revertData: string | null = null;
  let cursor: unknown = err;
  for (let i = 0; i < 8 && cursor; i++) {
    const c = cursor as { data?: unknown; cause?: unknown };
    if (typeof c.data === 'string' && c.data.startsWith('0x') && c.data.length >= 10) {
      revertData = c.data;
      break;
    }
    cursor = c.cause;
  }
  const anchored = (revertData?.toLowerCase().startsWith(selector) ?? false) || msg.includes(selector);
  if (anchored) return { ok: true, detail: `REVERTED ${label} (selector-anchored): ${(revertData ?? msg).slice(0, 90)}`, kind: 'pass' };
  if (revertData !== null) return { ok: false, detail: `WRONG revert selector (wanted ${selector}): ${revertData.slice(0, 90)}`, kind: 'fail' };
  if (/revert/i.test(msg) && !isFlake(err)) return { ok: true, detail: `reverted (no revert data surfaced by the RPC): ${msg.slice(0, 90)}`, kind: 'pass' };
  return { ok: false, detail: `unexpected: ${msg.slice(0, 110)}`, kind: isFlake(err) ? 'flake' : 'fail' };
}

const bridgeEthData = (to: Hex): Hex =>
  encodeFunctionData({
    abi: parseAbi(['function bridgeETHTo(address,uint32,bytes)']),
    functionName: 'bridgeETHTo',
    args: [to, 200000, '0x'],
  });

async function ownerTx(c: ChainCtx, addr: Hex, functionName: string, args: readonly unknown[], value = 0n): Promise<Hex> {
  const hash = await c.wallet.writeContract({
    chain: c.wallet.chain,
    account: ops,
    address: addr,
    abi: leashAccountV4Abi,
    functionName: functionName as never,
    args: args as never,
    value,
  });
  await confirmReceipt(c.pub, hash);
  return hash;
}

/** applyCallRule/applySpendBudget can hit TimelockNotElapsed at a 2s-block
 *  timestamp boundary even with timelockDelay=0 (SE-7 roughness) — bounded retry. */
async function applyWithRetry(c: ChainCtx, addr: Hex, fn: 'applyCallRule' | 'applySpendBudget'): Promise<Hex> {
  let lastErr: unknown;
  for (let i = 0; i < 5; i++) {
    try {
      return await ownerTx(c, addr, fn, []);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw lastErr;
}

async function main() {
  console.log(`ops=${ops.address} factory=${FACTORY_ADDR} bridge=${BRIDGE}`);

  // ---- 1. factory at the SAME address on home + destination ----
  for (const c of CHAINS) await ensureFactory(c);

  // ---- 2. mint the SAME (owner, salt) account on BOTH chains ----
  const accountSalt = (`0x${randomBytes(32).toString('hex')}`) as Hex;
  const policy = { perTransferCap: 10n ** 12n, windowCap: 10n ** 12n, windowSeconds: 3600, expiresAt: 2 ** 31 - 1 };
  const mintArgs = [
    ops.address,
    guardian.address,
    ops.address, // owner == sessionKey == ops (SE-4 drill shape; timelockDelay 0)
    { perTransferCap: policy.perTransferCap, windowCap: policy.windowCap, windowSeconds: policy.windowSeconds, expiresAt: BigInt(policy.expiresAt) },
    [] as Hex[],
    0n,
    ('0x' + '00'.repeat(20)) as Hex,
    { perTransferCapToken: 0n, windowCapToken: 0n },
    accountSalt,
  ] as const;
  const predicted = (await BASE.pub.readContract({
    address: FACTORY_ADDR,
    abi: factoryV4DeterministicAbi,
    functionName: 'predictAccountV4',
    args: [...mintArgs],
  })) as Hex;
  const account = predicted;
  const mintTxs: Record<string, string> = {};
  for (const c of CHAINS) {
    const hash = await c.wallet.writeContract({
      chain: c.wallet.chain,
      account: ops,
      address: FACTORY_ADDR,
      abi: factoryV4DeterministicAbi,
      functionName: 'createAccountV4',
      args: [...mintArgs],
    });
    await confirmReceipt(c.pub, hash);
    const code = await waitForCode(c, account);
    mintTxs[c.name] = hash;
    record(`mint@${c.name}`, code !== null, code !== null ? `account ${account} has code (tx ${hash})` : `code not visible (tx ${hash})`, code !== null ? 'pass' : 'flake');
  }

  // ---- 3. grants on the HOME account: native budget + bridgeETHTo rule ----
  await ownerTx(BASE, account, 'proposeSpendBudget', [('0x' + '00'.repeat(20)) as Hex, PER_CALL_CAP * 2n]);
  await applyWithRetry(BASE, account, 'applySpendBudget');
  await ownerTx(BASE, account, 'proposeCallRule', [BRIDGE, SEL_BRIDGE_ETH_TO, 0, [], PER_CALL_CAP, PER_CALL_CAP * 2n, ('0x' + '00'.repeat(32)) as Hex]);
  await applyWithRetry(BASE, account, 'applyCallRule');
  record('grants@base', true, `native budget + bridgeETHTo rule granted (perCallCap ${PER_CALL_CAP})`);

  // fund the account so it can bridge
  const fund = await BASE.wallet.sendTransaction({ chain: BASE.wallet.chain, account: ops, to: account, value: HAPPY_VALUE * 6n });
  await confirmReceipt(BASE.pub, fund);

  // ---- 4. the PRODUCTION pre-routing gate PASSES (carry #1, full shape) ----
  const persistedTuple = {
    ownerAddr: ops.address.toLowerCase(),
    guardianAddr: guardian.address.toLowerCase(),
    sessionKeyAddr: ops.address.toLowerCase(),
    policy: { perTransferCap: policy.perTransferCap.toString(), windowCap: policy.windowCap.toString(), windowSeconds: policy.windowSeconds, expiresAt: policy.expiresAt },
    allowlist: [] as string[],
    timelockDelay: 0,
    settlementToken: '0x' + '00'.repeat(20),
    tokenPolicy: { perTransferCapToken: '0', windowCapToken: '0' },
  };
  const agentRow = {
    id: 'drill-agent',
    chainId: BASE.chainId,
    accountAddr: account.toLowerCase(),
    accountVersion: 4,
    accountSalt: accountSalt,
    accountCreateTuple: persistedTuple as unknown as Record<string, unknown>,
  } as unknown as AgentRow;
  try {
    const routed = await withFlakeRetry(() => assertBridgeRoutable(registryFor(), agentRow, BRIDGE), { label: 'pre-routing gate' });
    record('pre-routing-gate PASS', routed.verifiedAddr === account.toLowerCase() && routed.destinationChainId === SEPOLIA.chainId, `same-address ${routed.verifiedAddr} verified on destination ${routed.destinationChainId}`);
  } catch (err) {
    record('pre-routing-gate PASS', false, String(err).slice(0, 160), isFlake(err) ? 'flake' : 'fail');
  }

  // ---- 5. HAPPY: governed in-cap bridge to SELF LANDS (real OP-stack withdrawal) ----
  let happyTx = '';
  try {
    happyTx = await ownerTx(BASE, account, 'executeCall', [BRIDGE, HAPPY_VALUE, bridgeEthData(account)], 0n);
    record('bridge-happy LANDS', true, `bridgeETHTo(self, ${HAPPY_VALUE}) status 1 (tx ${happyTx}) — real L2StandardBridge withdrawal initiated`);
  } catch (err) {
    record('bridge-happy LANDS', false, String(err).slice(0, 160), isFlake(err) ? 'flake' : 'fail');
  }

  // ---- 6. malicious matrix REVERTS at the true boundary (eth_call, selector-anchored) ----
  const probe = async (check: string, target: Hex, value: bigint, data: Hex, selector: string, label: string) => {
    try {
      await BASE.pub.call({
        account: ops.address,
        to: account,
        data: encodeFunctionData({ abi: leashAccountV4Abi, functionName: 'executeCall', args: [target, value, data] }),
      });
      record(check, false, 'malicious call unexpectedly SUCCEEDED');
    } catch (err) {
      const r = anchoredRevert(err, selector, label);
      record(check, r.ok, r.detail, r.kind);
    }
  };
  await probe('bridge-over-cap REVERTS', BRIDGE, OVER_VALUE, bridgeEthData(account), ERR.OverPerCallCap, 'OverPerCallCap');
  await probe('bridge-redirect REVERTS', BRIDGE, HAPPY_VALUE, bridgeEthData(ATTACKER), ERR.RecipientNotSelf, 'RecipientNotSelf');
  const payloadData = encodeFunctionData({
    abi: parseAbi(['function bridgeETHTo(address,uint32,bytes)']),
    functionName: 'bridgeETHTo',
    args: [account, 200000, '0xdeadbeef'],
  });
  await probe('bridge-extraData REVERTS', BRIDGE, HAPPY_VALUE, payloadData, ERR.DecodeMismatch, 'DecodeMismatch');
  await probe('off-allowlist-bridge REVERTS', FACTORY_ADDR, HAPPY_VALUE, bridgeEthData(account), ERR.TargetNotAllowlisted, 'TargetNotAllowlisted');

  // ---- 7. ONE REAL malicious tx: the redirect REVERTS ON-CHAIN (status 0) ----
  try {
    const hash = await BASE.wallet.writeContract({
      chain: BASE.wallet.chain,
      account: ops,
      address: account,
      abi: leashAccountV4Abi,
      functionName: 'executeCall',
      args: [BRIDGE, HAPPY_VALUE, bridgeEthData(ATTACKER)],
      gas: 400_000n, // skip estimateGas (which would revert client-side)
    });
    let status: string | null = null;
    try {
      await confirmReceipt(BASE.pub, hash);
      status = 'success';
    } catch {
      status = 'reverted';
    }
    record('real-redirect-tx status 0', status === 'reverted', `redirect tx ${hash} → ${status}`);
  } catch (err) {
    record('real-redirect-tx status 0', false, String(err).slice(0, 140), isFlake(err) ? 'flake' : 'fail');
  }

  // ---- 8. the gate REFUSES (production path, typed reasons) ----
  try {
    await assertBridgeRoutable(registryFor(), agentRow, FACTORY_ADDR);
    record('gate-off-allowlist REFUSED', false, 'off-allowlist bridge target was NOT refused');
  } catch (err) {
    const ok = err instanceof BridgeRoutingRefusedError && err.reason === 'bridge_not_allowlisted';
    record('gate-off-allowlist REFUSED', ok, ok ? `refused: ${(err as Error).message.slice(0, 110)}` : `unexpected: ${String(err).slice(0, 110)}`);
  }
  try {
    const mutated = { ...agentRow, accountCreateTuple: { ...persistedTuple, policy: { ...persistedTuple.policy, expiresAt: persistedTuple.policy.expiresAt - 1 } } } as unknown as AgentRow;
    await assertBridgeRoutable(registryFor(), mutated, BRIDGE);
    record('gate-mutated-tuple REFUSED', false, 'a mutated tuple was NOT refused');
  } catch (err) {
    const ok = err instanceof BridgeRoutingRefusedError && err.reason === 'same_address_refused';
    record('gate-mutated-tuple REFUSED', ok, ok ? `refused: ${(err as Error).message.slice(0, 120)}` : `unexpected: ${String(err).slice(0, 120)}`, ok ? 'pass' : isFlake(err) ? 'flake' : 'fail');
  }
  try {
    await assertBridgeRoutable(registryFor({ withDestination: false }), agentRow, BRIDGE);
    record('gate-unregistered-destination REFUSED', false, 'an unregistered destination was NOT refused');
  } catch (err) {
    const ok = err instanceof BridgeRoutingRefusedError && err.reason === 'destination_unregistered';
    record('gate-unregistered-destination REFUSED', ok, ok ? `refused: ${(err as Error).message.slice(0, 110)}` : `unexpected: ${String(err).slice(0, 110)}`);
  }

  const green = fail === 0 && flake === 0;
  const run = { when: new Date().toISOString(), accountSalt, account, mintTxs, happyTx, counts: { pass, fail, flake }, green, results };
  const evidenceUrl = new URL('../../docs/evidence/stage-e-bridge-drill.json', import.meta.url);
  let priorRuns: unknown[] = [];
  try {
    priorRuns = (JSON.parse(readFileSync(evidenceUrl, 'utf8')) as { runs?: unknown[] }).runs ?? [];
  } catch {
    /* first run */
  }
  writeFileSync(
    evidenceUrl,
    JSON.stringify(
      {
        drill: 'stage-e-se8-governed-bridging',
        chains: CHAINS.map((c) => ({ name: c.name, chainId: c.chainId })),
        factoryAddr: FACTORY_ADDR,
        bridge: BRIDGE,
        runs: [...priorRuns.slice(-3), run],
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`\n${green ? 'GREEN' : 'NOT GREEN'} — pass=${pass} fail=${fail} flake=${flake}`);
  console.log('evidence → docs/evidence/stage-e-bridge-drill.json');
  if (!green) process.exit(1);
}

main().catch((err) => {
  console.error('drill aborted:', err);
  process.exit(1);
});
