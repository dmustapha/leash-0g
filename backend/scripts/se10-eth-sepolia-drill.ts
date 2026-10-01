// SE-10 E-11 [DEPLOY] drill — Ethereum Sepolia PROMOTION to a FULL governed chain,
// LIVE on Ethereum Sepolia (11155111). Closes Stage E's chain fan-out: Eth Sepolia
// goes from a bridge-DESTINATION-only chain (SE-8) to a full governed home chain
// where a home agent runs the same sense→decide→gate→act wall against a REAL
// protocol — proving the model is a THIN REPEAT (config, not code).
//
// Against the REAL canonical WETH9 on Eth Sepolia it shows:
//   1. the deterministic V4 factory (same bytecode as every other chain) sits at the
//      SAME address (idempotent ensure);
//   2. the same (owner, salt) + tuple mints the account at the SAME CREATE2 address;
//   3. a governed HAPPY call — `transfer(self, amount)` of REAL WETH within caps —
//      LANDS on the real token contract (status 1);
//   4. the FULL malicious matrix REVERTS at the true boundary, selector-anchored:
//      off-allowlist → TargetNotAllowlisted · over-cap → OverPerCallCap · redirect →
//      RecipientNotSelf · bad payload → DecodeMismatch — plus ONE REAL redirect tx
//      confirmed status 0 on-chain;
//   5. DEFAULT-DENY (E-11): a chain NOT in the registry cannot be resolved/targeted
//      (UnregisteredChainError) — the negative drill case;
//   6. typed gate refusals hold uniformly on the Eth-Sepolia-inclusive registry:
//      destination_unregistered + destination_chainid_mismatch.
//
// Run: cd backend && npx tsx scripts/se10-eth-sepolia-drill.ts
// Requires (backend/.env): ETHEREUM_SEPOLIA_RPC, OPS_PRIVATE_KEY, GUARDIAN_PRIVATE_KEY.
//   ops must hold Eth-Sepolia gas. The drill wraps a little ETH→WETH to fund the account.
// SE-4 conventions: transport-only flake tolerance, same-hash receipt re-poll, fresh
// account salt per run (idempotent), green iff fail==0 AND flake==0, evidence with runs
// history → docs/evidence/stage-e-se10-promotion-drill.json.
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
import { ChainRegistry, UnregisteredChainError, type ChainConfig } from '../src/chain/registry.js';
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
  if (!v) throw new Error(`SE-10 drill requires ${name} in backend/.env (see header)`);
  return v;
}

const CREATE2_DEPLOYER = '0x4e59b44847b379578588920cA78FbF26c0B4956C' as Hex;
const FACTORY_SALT = keccak256(stringToHex('LEASH-V4-DETERMINISTIC-FACTORY-v1'));
const ETH_SEPOLIA_ID = 11155111;
const UNREGISTERED_CHAIN_ID = 999999; // never onboarded → default-deny

// Canonical WETH9 on Ethereum Sepolia — a REAL protocol contract on that chain.
const WETH = '0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9'.toLowerCase() as Hex;
const SEL_TRANSFER = '0xa9059cbb';
const ERR = {
  OverPerCallCap: '0x2671b8a6',
  RecipientNotSelf: '0x239e7696',
  DecodeMismatch: '0xee0f83ce',
  TargetNotAllowlisted: '0x042a9b0d',
} as const;

const PER_CALL_CAP = BigInt(env.SEPOLIA_PER_CALL_CAP ?? '200000000000000'); // 2e14 wei WETH
const HAPPY_AMOUNT = BigInt(env.SEPOLIA_HAPPY_AMOUNT ?? '100000000000000'); // in-cap
const OVER_AMOUNT = PER_CALL_CAP + 1n;

const ops = privateKeyToAccount(requireEnv('OPS_PRIVATE_KEY') as Hex);
const guardian = privateKeyToAccount(requireEnv('GUARDIAN_PRIVATE_KEY') as Hex);
const ATTACKER = ('0x' + 'be'.repeat(20)) as Hex;

interface ChainCtx { name: string; chainId: number; rpc: string; pub: PublicClient; wallet: WalletClient }
function ctx(name: string, chainId: number, rpc: string): ChainCtx {
  const chain = zeroGChain(rpc, chainId);
  return { name, chainId, rpc, pub: createPublicClient({ chain, transport: http(rpc) }), wallet: createWalletClient({ chain, transport: http(rpc), account: ops }) };
}
const SEPOLIA = ctx('ethereum-sepolia', ETH_SEPOLIA_ID, requireEnv('ETHEREUM_SEPOLIA_RPC'));

const artifact = JSON.parse(
  readFileSync(new URL('../../contracts/out/LeashAccountV4FactoryDeterministic.sol/LeashAccountV4FactoryDeterministic.json', import.meta.url), 'utf8'),
) as { bytecode: { object: Hex } };
const FACTORY_INITCODE = artifact.bytecode.object;
const FACTORY_ADDR = getCreate2Address({ from: CREATE2_DEPLOYER, salt: FACTORY_SALT, bytecodeHash: keccak256(FACTORY_INITCODE) });

let pass = 0, fail = 0, flake = 0;
const results: Array<{ check: string; ok: boolean; detail: string }> = [];
function record(check: string, ok: boolean, detail: string, kind: 'pass' | 'fail' | 'flake' = ok ? 'pass' : 'fail') {
  if (kind === 'flake') flake++; else if (ok) pass++; else fail++;
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
  if (code && code !== '0x') { record(`factory@${c.name}`, true, `already deployed at ${FACTORY_ADDR} (idempotent skip)`); return; }
  const hash = await c.wallet.sendTransaction({ chain: c.wallet.chain, account: ops, to: CREATE2_DEPLOYER, data: (FACTORY_SALT + FACTORY_INITCODE.slice(2)) as Hex });
  await confirmReceipt(c.pub, hash);
  const deployed = await waitForCode(c, FACTORY_ADDR);
  record(`factory@${c.name}`, deployed !== null, deployed !== null ? `deployed at ${FACTORY_ADDR} (tx ${hash})` : `code not visible (tx ${hash})`, deployed !== null ? 'pass' : 'flake');
}

const transferData = (to: Hex, amount: bigint): Hex =>
  encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256)']), functionName: 'transfer', args: [to, amount] });

async function ownerTx(c: ChainCtx, addr: Hex, functionName: string, args: readonly unknown[], value = 0n): Promise<Hex> {
  const hash = await c.wallet.writeContract({ chain: c.wallet.chain, account: ops, address: addr, abi: leashAccountV4Abi, functionName: functionName as never, args: args as never, value });
  await confirmReceipt(c.pub, hash);
  return hash;
}
async function applyWithRetry(c: ChainCtx, addr: Hex, fn: 'applyCallRule' | 'applySpendBudget'): Promise<Hex> {
  let lastErr: unknown;
  for (let i = 0; i < 5; i++) {
    try { return await ownerTx(c, addr, fn, []); } catch (err) { lastErr = err; await new Promise((r) => setTimeout(r, 3000)); }
  }
  throw lastErr;
}

/** Walk the viem cause-chain for raw revert data; anchor on the expected selector. */
function anchoredRevert(err: unknown, selector: string, label: string): { ok: boolean; detail: string; kind: 'pass' | 'fail' | 'flake' } {
  const msg = String((err as { shortMessage?: string; message?: string }).shortMessage ?? (err as Error).message ?? err);
  let revertData: string | null = null;
  let cursor: unknown = err;
  for (let i = 0; i < 8 && cursor; i++) {
    const c = cursor as { data?: unknown; cause?: unknown };
    if (typeof c.data === 'string' && c.data.startsWith('0x') && c.data.length >= 10) { revertData = c.data; break; }
    cursor = c.cause;
  }
  const anchored = (revertData?.toLowerCase().startsWith(selector) ?? false) || msg.includes(selector);
  if (anchored) return { ok: true, detail: `REVERTED ${label} (selector-anchored): ${(revertData ?? msg).slice(0, 90)}`, kind: 'pass' };
  if (revertData !== null) return { ok: false, detail: `WRONG revert selector (wanted ${selector}): ${revertData.slice(0, 90)}`, kind: 'fail' };
  // sec L-03 (SE-10 gate): the malicious matrix uses eth_call, which reliably surfaces
  // revert data — so a selector MUST anchor. A bare "revert" message with no data is
  // NOT accepted as a pass (that would weaken the "selector-anchored" guarantee); it is
  // a fail unless it is a genuine transport flake.
  return { ok: false, detail: `unexpected (no selector-anchored revert data): ${msg.slice(0, 110)}`, kind: isFlake(err) ? 'flake' : 'fail' };
}

const SIGNING = { opsPrivateKey: requireEnv('OPS_PRIVATE_KEY'), guardianPrivateKey: requireEnv('GUARDIAN_PRIVATE_KEY') };
/** Registry with Eth Sepolia as a promoted home chain + an optional bridge-destination config (for the gate-refusal proofs). */
function registryFor(opts: { destChainId?: number; destRegistered?: boolean; destRpc?: string } = {}): ChainRegistry {
  const SYN_BRIDGE = ('0x' + 'b0'.repeat(20)) as string; // synthetic bridge target (gate-logic proof only)
  const destChainId = opts.destChainId ?? 84532;
  const configs: ChainConfig[] = [
    {
      chainId: SEPOLIA.chainId,
      name: SEPOLIA.name,
      rpcUrl: SEPOLIA.rpc,
      factoryV4Addr: FACTORY_ADDR,
      registryAddr: (env.AGENT_REGISTRY_SEPOLIA_ADDR ?? '0x' + '00'.repeat(20)) as string,
      accountVersion: 4,
      gasFloorWei: 0n,
      canonical: { settlementToken: WETH },
      protocolAllowlist: [WETH],
      bridgeAllowlist: [SYN_BRIDGE],
      bridgeDestinations: { [SYN_BRIDGE.toLowerCase()]: destChainId },
    },
  ];
  if (opts.destRegistered !== false) {
    configs.push({
      chainId: destChainId,
      name: `dest-${destChainId}`,
      rpcUrl: opts.destRpc ?? SEPOLIA.rpc, // default: the dest RPC self-reports 11155111
      factoryV4Addr: FACTORY_ADDR,
      registryAddr: (env.AGENT_REGISTRY_BASE_ADDR ?? '0x' + '00'.repeat(20)) as string,
      accountVersion: 4,
      gasFloorWei: 0n,
    });
  }
  return new ChainRegistry(configs, SIGNING);
}

async function main() {
  console.log(`ops=${ops.address} factory=${FACTORY_ADDR} weth=${WETH}`);
  await ensureFactory(SEPOLIA);

  // ---- mint the SAME (owner, salt) account on Eth Sepolia (SE-6 same-address) ----
  const accountSalt = (`0x${randomBytes(32).toString('hex')}`) as Hex;
  const policy = { perTransferCap: 10n ** 12n, windowCap: 10n ** 12n, windowSeconds: 3600, expiresAt: 2 ** 31 - 1 };
  const mintArgs = [
    ops.address, guardian.address, ops.address,
    { perTransferCap: policy.perTransferCap, windowCap: policy.windowCap, windowSeconds: policy.windowSeconds, expiresAt: BigInt(policy.expiresAt) },
    [] as Hex[], 0n, ('0x' + '00'.repeat(20)) as Hex, { perTransferCapToken: 0n, windowCapToken: 0n }, accountSalt,
  ] as const;
  const account = (await SEPOLIA.pub.readContract({ address: FACTORY_ADDR, abi: factoryV4DeterministicAbi, functionName: 'predictAccountV4', args: [...mintArgs] })) as Hex;
  const mintTx = await SEPOLIA.wallet.writeContract({ chain: SEPOLIA.wallet.chain, account: ops, address: FACTORY_ADDR, abi: factoryV4DeterministicAbi, functionName: 'createAccountV4', args: [...mintArgs] });
  await confirmReceipt(SEPOLIA.pub, mintTx);
  const code = await waitForCode(SEPOLIA, account);
  record('mint@ethereum-sepolia', code !== null, code !== null ? `account ${account} has code (tx ${mintTx})` : `code not visible (tx ${mintTx})`, code !== null ? 'pass' : 'flake');

  // ---- grants: WETH token budget + transfer(self) rule ----
  await ownerTx(SEPOLIA, account, 'proposeSpendBudget', [WETH, PER_CALL_CAP * 4n]);
  await applyWithRetry(SEPOLIA, account, 'applySpendBudget');
  await ownerTx(SEPOLIA, account, 'proposeCallRule', [WETH, SEL_TRANSFER, 0, [], PER_CALL_CAP, PER_CALL_CAP * 2n, ('0x' + '00'.repeat(32)) as Hex]);
  await applyWithRetry(SEPOLIA, account, 'applyCallRule');
  record('grants@ethereum-sepolia', true, `WETH budget + transfer(self) rule granted (perCallCap ${PER_CALL_CAP})`);

  // ---- fund the account with REAL WETH (wrap ETH, transfer WETH in) ----
  const wrapTx = await SEPOLIA.wallet.sendTransaction({ chain: SEPOLIA.wallet.chain, account: ops, to: WETH, value: HAPPY_AMOUNT * 4n, data: '0xd0e30db0' });
  await confirmReceipt(SEPOLIA.pub, wrapTx);
  const fundTx = await SEPOLIA.wallet.writeContract({ chain: SEPOLIA.wallet.chain, account: ops, address: WETH, abi: parseAbi(['function transfer(address,uint256) returns (bool)']), functionName: 'transfer', args: [account, HAPPY_AMOUNT * 2n] });
  await confirmReceipt(SEPOLIA.pub, fundTx);

  // ---- HAPPY: governed transfer(self) LANDS on the real WETH contract ----
  let happyTx = '';
  try {
    happyTx = await ownerTx(SEPOLIA, account, 'executeCall', [WETH, 0n, transferData(account, HAPPY_AMOUNT)], 0n);
    record('real-protocol-happy LANDS', true, `transfer(self, ${HAPPY_AMOUNT}) status 1 (tx ${happyTx}) — real WETH move inside the leashed account`);
  } catch (err) {
    record('real-protocol-happy LANDS', false, String(err).slice(0, 180), isFlake(err) ? 'flake' : 'fail');
  }

  // ---- malicious matrix REVERTS at the true boundary (eth_call, selector-anchored) ----
  const probe = async (check: string, target: Hex, value: bigint, data: Hex, selector: string, label: string) => {
    try {
      await SEPOLIA.pub.call({ account: ops.address, to: account, data: encodeFunctionData({ abi: leashAccountV4Abi, functionName: 'executeCall', args: [target, value, data] }) });
      record(check, false, 'malicious call unexpectedly SUCCEEDED');
    } catch (err) {
      const r = anchoredRevert(err, selector, label);
      record(check, r.ok, r.detail, r.kind);
    }
  };
  await probe('over-cap REVERTS', WETH, 0n, transferData(account, OVER_AMOUNT), ERR.OverPerCallCap, 'OverPerCallCap');
  await probe('redirect REVERTS', WETH, 0n, transferData(ATTACKER, HAPPY_AMOUNT), ERR.RecipientNotSelf, 'RecipientNotSelf');
  await probe('bad-payload REVERTS', WETH, 0n, (transferData(account, HAPPY_AMOUNT) + 'deadbeef') as Hex, ERR.DecodeMismatch, 'DecodeMismatch');
  await probe('off-allowlist REVERTS', FACTORY_ADDR, 0n, transferData(account, HAPPY_AMOUNT), ERR.TargetNotAllowlisted, 'TargetNotAllowlisted');

  // ---- ONE REAL malicious tx: the redirect REVERTS ON-CHAIN (status 0) ----
  try {
    const hash = await SEPOLIA.wallet.writeContract({ chain: SEPOLIA.wallet.chain, account: ops, address: account, abi: leashAccountV4Abi, functionName: 'executeCall', args: [WETH, 0n, transferData(ATTACKER, HAPPY_AMOUNT)], gas: 500_000n });
    let status: string;
    try { await confirmReceipt(SEPOLIA.pub, hash); status = 'success'; } catch { status = 'reverted'; }
    record('real-redirect-tx status 0', status === 'reverted', `redirect tx ${hash} → ${status}`);
  } catch (err) {
    record('real-redirect-tx status 0', false, String(err).slice(0, 140), isFlake(err) ? 'flake' : 'fail');
  }

  // ---- DEFAULT-DENY (E-11): a chain NOT in the registry cannot be resolved/targeted ----
  try {
    registryFor().getChainOps(UNREGISTERED_CHAIN_ID);
    record('default-deny unregistered-chain', false, `chain ${UNREGISTERED_CHAIN_ID} was unexpectedly resolvable`);
  } catch (err) {
    const ok = err instanceof UnregisteredChainError && err.chainId === UNREGISTERED_CHAIN_ID;
    record('default-deny unregistered-chain', ok, ok ? `refused: ${(err as Error).message.slice(0, 110)}` : `unexpected: ${String(err).slice(0, 110)}`);
  }

  // ---- typed gate refusals hold on the Eth-Sepolia-inclusive registry ----
  const persistedTuple = {
    ownerAddr: ops.address.toLowerCase(), guardianAddr: guardian.address.toLowerCase(), sessionKeyAddr: ops.address.toLowerCase(),
    policy: { perTransferCap: policy.perTransferCap.toString(), windowCap: policy.windowCap.toString(), windowSeconds: policy.windowSeconds, expiresAt: policy.expiresAt },
    allowlist: [] as string[], timelockDelay: 0, settlementToken: '0x' + '00'.repeat(20), tokenPolicy: { perTransferCapToken: '0', windowCapToken: '0' },
  };
  const agentRow = { id: 'drill-agent', chainId: SEPOLIA.chainId, accountAddr: account.toLowerCase(), accountVersion: 4, accountSalt, accountCreateTuple: persistedTuple as unknown as Record<string, unknown> } as unknown as AgentRow;
  const SYN_BRIDGE = ('0x' + 'b0'.repeat(20)) as Hex;
  try {
    await assertBridgeRoutable(registryFor({ destRegistered: false }), agentRow, SYN_BRIDGE);
    record('gate-unregistered-destination REFUSED', false, 'an unregistered destination was NOT refused');
  } catch (err) {
    const ok = err instanceof BridgeRoutingRefusedError && err.reason === 'destination_unregistered';
    record('gate-unregistered-destination REFUSED', ok, ok ? `refused: ${(err as Error).message.slice(0, 110)}` : `unexpected: ${String(err).slice(0, 110)}`);
  }
  try {
    // dest config CLAIMS chainId 84532 but its RPC self-reports 11155111 → mismatch.
    await assertBridgeRoutable(registryFor({ destChainId: 84532, destRpc: SEPOLIA.rpc }), agentRow, SYN_BRIDGE);
    record('gate-chainid-mismatch REFUSED (L-02)', false, 'a destination-RPC chainId mismatch was NOT refused');
  } catch (err) {
    const ok = err instanceof BridgeRoutingRefusedError && err.reason === 'destination_chainid_mismatch';
    record('gate-chainid-mismatch REFUSED (L-02)', ok, ok ? `refused: ${(err as Error).message.slice(0, 120)}` : `unexpected: ${String(err).slice(0, 120)}`, ok ? 'pass' : isFlake(err) ? 'flake' : 'fail');
  }

  const green = fail === 0 && flake === 0;
  const run = { when: new Date().toISOString(), accountSalt, account, weth: WETH, mintTx, happyTx, counts: { pass, fail, flake }, green, results };
  const evidenceUrl = new URL('../../docs/evidence/stage-e-se10-promotion-drill.json', import.meta.url);
  let priorRuns: unknown[] = [];
  try { priorRuns = (JSON.parse(readFileSync(evidenceUrl, 'utf8')) as { runs?: unknown[] }).runs ?? []; } catch { /* first run */ }
  writeFileSync(evidenceUrl, JSON.stringify({ drill: 'stage-e-se10-ethereum-sepolia-promotion', chains: [{ name: SEPOLIA.name, chainId: SEPOLIA.chainId }], factoryAddr: FACTORY_ADDR, weth: WETH, runs: [...priorRuns.slice(-3), run] }, null, 2) + '\n');
  console.log(`\n${green ? 'GREEN' : 'NOT GREEN'} — pass=${pass} fail=${fail} flake=${flake}`);
  console.log('evidence → docs/evidence/stage-e-se10-promotion-drill.json');
  if (!green) process.exit(1);
}

main().catch((err) => { console.error('drill aborted:', err); process.exit(1); });
