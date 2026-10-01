// SE-9 E-10 [DEPLOY] drill — GOVERNED BRIDGING on the DIVERGENT Arbitrum family,
// LIVE on Arbitrum Sepolia (home, 421614) + Ethereum Sepolia (destination, 11155111).
//
// Proves governance is CHAIN-AGNOSTIC: a second bridge FAMILY (Arbitrum
// GatewayRouter `outboundTransfer` / ArbSys `withdrawEth` — NOT the OP-stack
// `bridgeETHTo`/`bridgeERC20To`) runs through the SAME classify → pre-routing-gate
// → wall spine with only a new decoder + config. Against the REAL Arbitrum L2
// GatewayRouter it shows:
//   1. the deterministic V4 factory (SE-9 bytecode, with the Arbitrum decoders)
//      sits at the SAME address on home + destination (idempotent ensure);
//   2. the same (owner, salt) + tuple mints the account at the SAME address on
//      BOTH chains — the far-chain funds destination is a REAL leashed account;
//   3. the PRODUCTION pre-routing gate (`assertBridgeRoutable`, incl. the SE-9
//      L-02 eth_chainId cross-check) PASSES in its full shape;
//   4. a governed ERC-20 bridge (carry #3: the LIVE leg for Arbitrum) —
//      approve(l2gateway) then `outboundTransfer(l1Token, self, amount)` within
//      the bridged-amount cap — LANDS (real GatewayRouter withdrawal, status 1);
//   5. the malicious matrix REVERTS at the true boundary, selector-anchored:
//      over-cap → OverPerCallCap · redirect → RecipientNotSelf · non-empty data →
//      DecodeMismatch · off-allowlist target → TargetNotAllowlisted — plus ONE
//      REAL redirect tx confirmed status 0 on-chain;
//   6. the gate REFUSES: off-bridge-allowlist target, a mutated tuple (same-address
//      drift), an unregistered destination (E-11), and a destination-RPC chainId
//      mismatch (L-02).
//
// Run: cd backend && npx tsx scripts/se9-bridge-drill.ts
// Requires (backend/.env): ARBITRUM_SEPOLIA_RPC, ETHEREUM_SEPOLIA_RPC, OPS_PRIVATE_KEY,
//   GUARDIAN_PRIVATE_KEY, ARB_CAP_BRIDGE_TOKEN_L2 (the L2 token that moves),
//   ARB_CAP_BRIDGE_TOKEN_L1 (its L1 counterpart = outboundTransfer arg0).
//   ARB_BRIDGE_ALLOWLIST ("<router>:11155111") OR ARB_L2_GATEWAY_ROUTER; the L2 ERC-20
//   gateway (the approve spender) is read from the router via getGateway(l1Token) when
//   ARB_L2_ERC20_GATEWAY is unset. ops must hold Arb-Sepolia gas + a balance of the L2 token.
// SE-4 conventions: transport-only flake tolerance, same-hash receipt re-poll, fresh
// account salt per run (idempotent), green iff fail==0 AND flake==0, evidence with runs
// history → docs/evidence/stage-e-se9-bridge-drill.json.
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

function requireEnv(name: string): string {
  const v = env[name];
  if (!v) throw new Error(`SE-9 drill requires ${name} in backend/.env (see header)`);
  return v;
}

const CREATE2_DEPLOYER = '0x4e59b44847b379578588920cA78FbF26c0B4956C' as Hex;
const FACTORY_SALT = keccak256(stringToHex('LEASH-V4-DETERMINISTIC-FACTORY-v1'));
const ARB_CHAIN_ID = 421614;
const ETH_SEPOLIA_ID = 11155111;

// selectors (Arbitrum divergent family)
const SEL_OUTBOUND_TRANSFER = '0x7b3a3c8b';
const SEL_APPROVE = '0x095ea7b3';
// error selectors (anchored, never regex-on-message alone)
const ERR = {
  OverPerCallCap: '0x2671b8a6',
  RecipientNotSelf: '0x239e7696',
  DecodeMismatch: '0xee0f83ce',
  TargetNotAllowlisted: '0x042a9b0d',
} as const;

const L1_TOKEN = requireEnv('ARB_CAP_BRIDGE_TOKEN_L1').toLowerCase() as Hex; // remote token (outboundTransfer arg0)
const L2_TOKEN = requireEnv('ARB_CAP_BRIDGE_TOKEN_L2').toLowerCase() as Hex; // the token that actually moves
// router = the L2 GatewayRouter (outboundTransfer target). From ARB_BRIDGE_ALLOWLIST "<router>:dest" or ARB_L2_GATEWAY_ROUTER.
const ROUTER = (() => {
  if (env.ARB_L2_GATEWAY_ROUTER) return env.ARB_L2_GATEWAY_ROUTER.toLowerCase() as Hex;
  const first = (env.ARB_BRIDGE_ALLOWLIST ?? '').split(',')[0]?.split(':')[0]?.trim().toLowerCase();
  if (!first || !/^0x[0-9a-f]{40}$/.test(first)) {
    throw new Error('SE-9 drill needs ARB_L2_GATEWAY_ROUTER or ARB_BRIDGE_ALLOWLIST "<router>:11155111"');
  }
  return first as Hex;
})();

// amounts (conservative — small live withdrawal). Overridable via env for odd-decimals tokens.
const PER_CALL_CAP = BigInt(env.ARB_BRIDGE_PER_CALL_CAP ?? '200000'); // token base-units bridged-amount cap
const HAPPY_AMOUNT = BigInt(env.ARB_BRIDGE_HAPPY_AMOUNT ?? '100000'); // in-cap
const OVER_AMOUNT = PER_CALL_CAP + 1n;

const ops = privateKeyToAccount(requireEnv('OPS_PRIVATE_KEY') as Hex);
const guardian = privateKeyToAccount(requireEnv('GUARDIAN_PRIVATE_KEY') as Hex);
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

const ARB = ctx('arbitrum-sepolia', ARB_CHAIN_ID, requireEnv('ARBITRUM_SEPOLIA_RPC'));
const SEPOLIA = ctx('ethereum-sepolia', ETH_SEPOLIA_ID, requireEnv('ETHEREUM_SEPOLIA_RPC'));
const CHAINS = [ARB, SEPOLIA];

const artifact = JSON.parse(
  readFileSync(
    new URL('../../contracts/out/LeashAccountV4FactoryDeterministic.sol/LeashAccountV4FactoryDeterministic.json', import.meta.url),
    'utf8',
  ),
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

/** The L2 ERC-20 gateway is the approve spender; read it from the router unless pinned in env. */
async function resolveGateway(): Promise<Hex> {
  if (env.ARB_L2_ERC20_GATEWAY) return env.ARB_L2_ERC20_GATEWAY.toLowerCase() as Hex;
  const gw = (await withFlakeRetry(
    () =>
      ARB.pub.readContract({
        address: ROUTER,
        abi: parseAbi(['function getGateway(address) view returns (address)']),
        functionName: 'getGateway',
        args: [L1_TOKEN],
      }),
    { label: 'getGateway' },
  )) as Hex;
  return gw.toLowerCase() as Hex;
}

function registryFor(opts: { withDestination?: boolean; destRpc?: string } = {}): ChainRegistry {
  const configs: ChainConfig[] = [
    {
      chainId: ARB.chainId,
      name: ARB.name,
      rpcUrl: ARB.rpc,
      factoryV4Addr: FACTORY_ADDR,
      registryAddr: (env.AGENT_REGISTRY_ARBITRUM_ADDR ?? '0x' + '00'.repeat(20)) as string,
      accountVersion: 4,
      gasFloorWei: 0n,
      bridgeAllowlist: [ROUTER],
      bridgeDestinations: { [ROUTER.toLowerCase()]: SEPOLIA.chainId },
    },
  ];
  if (opts.withDestination !== false) {
    configs.push({
      chainId: SEPOLIA.chainId,
      name: SEPOLIA.name,
      rpcUrl: opts.destRpc ?? SEPOLIA.rpc,
      factoryV4Addr: FACTORY_ADDR,
      registryAddr: (env.AGENT_REGISTRY_SEPOLIA_ADDR ?? '0x' + '00'.repeat(20)) as string,
      accountVersion: 4,
      gasFloorWei: 0n,
    });
  }
  return new ChainRegistry(configs, {
    opsPrivateKey: requireEnv('OPS_PRIVATE_KEY'),
    guardianPrivateKey: requireEnv('GUARDIAN_PRIVATE_KEY'),
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

const outboundData = (to: Hex, amount: bigint, data: Hex = '0x'): Hex =>
  encodeFunctionData({
    abi: parseAbi(['function outboundTransfer(address,address,uint256,bytes)']),
    functionName: 'outboundTransfer',
    args: [L1_TOKEN, to, amount, data],
  });

const approveData = (spender: Hex, amount: bigint): Hex =>
  encodeFunctionData({ abi: parseAbi(['function approve(address,uint256)']), functionName: 'approve', args: [spender, amount] });

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
  const GATEWAY = await resolveGateway();
  console.log(`ops=${ops.address} factory=${FACTORY_ADDR} router=${ROUTER} gateway=${GATEWAY} l1Token=${L1_TOKEN} l2Token=${L2_TOKEN}`);

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
  const predicted = (await ARB.pub.readContract({
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

  // ---- 3. grants on the HOME account: token budgets + approve rule + outboundTransfer rule ----
  // approve leg charges the L2 token budget; the bridge leg charges the L1 token budget (divergent key).
  await ownerTx(ARB, account, 'proposeSpendBudget', [L2_TOKEN, PER_CALL_CAP * 4n]);
  await applyWithRetry(ARB, account, 'applySpendBudget');
  await ownerTx(ARB, account, 'proposeSpendBudget', [L1_TOKEN, PER_CALL_CAP * 2n]);
  await applyWithRetry(ARB, account, 'applySpendBudget');
  await ownerTx(ARB, account, 'proposeCallRule', [L2_TOKEN, SEL_APPROVE, 0, [GATEWAY], PER_CALL_CAP * 2n, PER_CALL_CAP * 4n, ('0x' + '00'.repeat(32)) as Hex]);
  await applyWithRetry(ARB, account, 'applyCallRule');
  await ownerTx(ARB, account, 'proposeCallRule', [ROUTER, SEL_OUTBOUND_TRANSFER, 0, [], PER_CALL_CAP, PER_CALL_CAP * 2n, ('0x' + '00'.repeat(32)) as Hex]);
  await applyWithRetry(ARB, account, 'applyCallRule');
  record('grants@arb', true, `L2+L1 token budgets + approve(gateway) + outboundTransfer rule granted (perCallCap ${PER_CALL_CAP})`);

  // fund the account with the L2 token so it can bridge
  const fundTok = await ARB.wallet.writeContract({
    chain: ARB.wallet.chain,
    account: ops,
    address: L2_TOKEN,
    abi: parseAbi(['function transfer(address,uint256) returns (bool)']),
    functionName: 'transfer',
    args: [account, HAPPY_AMOUNT * 2n],
  });
  await confirmReceipt(ARB.pub, fundTok);

  // ---- 4. the PRODUCTION pre-routing gate PASSES (full shape, incl. L-02 chainId cross-check) ----
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
    chainId: ARB.chainId,
    accountAddr: account.toLowerCase(),
    accountVersion: 4,
    accountSalt: accountSalt,
    accountCreateTuple: persistedTuple as unknown as Record<string, unknown>,
  } as unknown as AgentRow;
  try {
    const routed = await withFlakeRetry(() => assertBridgeRoutable(registryFor(), agentRow, ROUTER), { label: 'pre-routing gate' });
    record('pre-routing-gate PASS', routed.verifiedAddr === account.toLowerCase() && routed.destinationChainId === SEPOLIA.chainId, `same-address ${routed.verifiedAddr} verified on destination ${routed.destinationChainId} (L-02 chainId cross-check passed)`);
  } catch (err) {
    record('pre-routing-gate PASS', false, String(err).slice(0, 160), isFlake(err) ? 'flake' : 'fail');
  }

  // ---- 5. HAPPY: governed ERC-20 bridge to SELF LANDS (carry #3 — the LIVE Arbitrum leg) ----
  let happyTx = '';
  try {
    await ownerTx(ARB, account, 'executeCall', [L2_TOKEN, 0n, approveData(GATEWAY, HAPPY_AMOUNT)], 0n);
    happyTx = await ownerTx(ARB, account, 'executeCall', [ROUTER, 0n, outboundData(account, HAPPY_AMOUNT)], 0n);
    record('bridge-happy LANDS', true, `outboundTransfer(l1Token, self, ${HAPPY_AMOUNT}) status 1 (tx ${happyTx}) — real Arbitrum GatewayRouter withdrawal initiated`);
  } catch (err) {
    record('bridge-happy LANDS', false, String(err).slice(0, 180), isFlake(err) ? 'flake' : 'fail');
  }

  // ---- 6. malicious matrix REVERTS at the true boundary (eth_call, selector-anchored) ----
  const probe = async (check: string, target: Hex, value: bigint, data: Hex, selector: string, label: string) => {
    try {
      await ARB.pub.call({
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
  await probe('bridge-over-cap REVERTS', ROUTER, 0n, outboundData(account, OVER_AMOUNT), ERR.OverPerCallCap, 'OverPerCallCap');
  await probe('bridge-redirect REVERTS', ROUTER, 0n, outboundData(ATTACKER, HAPPY_AMOUNT), ERR.RecipientNotSelf, 'RecipientNotSelf');
  await probe('bridge-data-payload REVERTS', ROUTER, 0n, outboundData(account, HAPPY_AMOUNT, '0xdeadbeef'), ERR.DecodeMismatch, 'DecodeMismatch');
  await probe('bridge-value-rides REVERTS', ROUTER, 1n, outboundData(account, HAPPY_AMOUNT), ERR.DecodeMismatch, 'DecodeMismatch(nonpayable)');
  await probe('off-allowlist-bridge REVERTS', FACTORY_ADDR, 0n, outboundData(account, HAPPY_AMOUNT), ERR.TargetNotAllowlisted, 'TargetNotAllowlisted');

  // ---- 7. ONE REAL malicious tx: the redirect REVERTS ON-CHAIN (status 0) ----
  try {
    const hash = await ARB.wallet.writeContract({
      chain: ARB.wallet.chain,
      account: ops,
      address: account,
      abi: leashAccountV4Abi,
      functionName: 'executeCall',
      args: [ROUTER, 0n, outboundData(ATTACKER, HAPPY_AMOUNT)],
      gas: 500_000n, // skip estimateGas (which would revert client-side)
    });
    let status: string | null = null;
    try {
      await confirmReceipt(ARB.pub, hash);
      status = 'success';
    } catch {
      status = 'reverted';
    }
    record('real-redirect-tx status 0', status === 'reverted', `redirect tx ${hash} → ${status}`);
  } catch (err) {
    record('real-redirect-tx status 0', false, String(err).slice(0, 140), isFlake(err) ? 'flake' : 'fail');
  }

  // ---- 8. the gate REFUSES (production path, typed reasons incl. the SE-9 L-02 one) ----
  try {
    await assertBridgeRoutable(registryFor(), agentRow, FACTORY_ADDR);
    record('gate-off-allowlist REFUSED', false, 'off-allowlist bridge target was NOT refused');
  } catch (err) {
    const ok = err instanceof BridgeRoutingRefusedError && err.reason === 'bridge_not_allowlisted';
    record('gate-off-allowlist REFUSED', ok, ok ? `refused: ${(err as Error).message.slice(0, 110)}` : `unexpected: ${String(err).slice(0, 110)}`);
  }
  try {
    const mutated = { ...agentRow, accountCreateTuple: { ...persistedTuple, policy: { ...persistedTuple.policy, expiresAt: persistedTuple.policy.expiresAt - 1 } } } as unknown as AgentRow;
    await assertBridgeRoutable(registryFor(), mutated, ROUTER);
    record('gate-mutated-tuple REFUSED', false, 'a mutated tuple was NOT refused');
  } catch (err) {
    const ok = err instanceof BridgeRoutingRefusedError && err.reason === 'same_address_refused';
    record('gate-mutated-tuple REFUSED', ok, ok ? `refused: ${(err as Error).message.slice(0, 120)}` : `unexpected: ${String(err).slice(0, 120)}`, ok ? 'pass' : isFlake(err) ? 'flake' : 'fail');
  }
  try {
    await assertBridgeRoutable(registryFor({ withDestination: false }), agentRow, ROUTER);
    record('gate-unregistered-destination REFUSED', false, 'an unregistered destination was NOT refused');
  } catch (err) {
    const ok = err instanceof BridgeRoutingRefusedError && err.reason === 'destination_unregistered';
    record('gate-unregistered-destination REFUSED', ok, ok ? `refused: ${(err as Error).message.slice(0, 110)}` : `unexpected: ${String(err).slice(0, 110)}`);
  }
  // SE-9 L-02: a destination RPC that self-reports the WRONG chain id is refused.
  try {
    await assertBridgeRoutable(registryFor({ destRpc: ARB.rpc }), agentRow, ROUTER); // dest config says 11155111 but RPC is Arb (421614)
    record('gate-chainid-mismatch REFUSED (L-02)', false, 'a destination-RPC chainId mismatch was NOT refused');
  } catch (err) {
    const ok = err instanceof BridgeRoutingRefusedError && err.reason === 'destination_chainid_mismatch';
    record('gate-chainid-mismatch REFUSED (L-02)', ok, ok ? `refused: ${(err as Error).message.slice(0, 120)}` : `unexpected: ${String(err).slice(0, 120)}`, ok ? 'pass' : isFlake(err) ? 'flake' : 'fail');
  }

  const green = fail === 0 && flake === 0;
  const run = { when: new Date().toISOString(), accountSalt, account, router: ROUTER, gateway: GATEWAY, l1Token: L1_TOKEN, l2Token: L2_TOKEN, mintTxs, happyTx, counts: { pass, fail, flake }, green, results };
  const evidenceUrl = new URL('../../docs/evidence/stage-e-se9-bridge-drill.json', import.meta.url);
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
        drill: 'stage-e-se9-governed-bridging-arbitrum',
        chains: CHAINS.map((c) => ({ name: c.name, chainId: c.chainId })),
        factoryAddr: FACTORY_ADDR,
        router: ROUTER,
        runs: [...priorRuns.slice(-3), run],
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`\n${green ? 'GREEN' : 'NOT GREEN'} — pass=${pass} fail=${fail} flake=${flake}`);
  console.log('evidence → docs/evidence/stage-e-se9-bridge-drill.json');
  if (!green) process.exit(1);
}

main().catch((err) => {
  console.error('drill aborted:', err);
  process.exit(1);
});
