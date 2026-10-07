/**
 * Stage F′ FP-4 P1 — LIVE DEPLOY-PATH RE-PROOF (build-order step 6).
 *
 * P1 replaced the EIP-170-oversized embedding factory with the generic `Create2Deployer`. This proves
 * the NEW production deploy path on real testnets: for each chain, build the V5 account initcode with
 * the BACKEND's own builder (src/chain/v5-initcode), deploy it via `Create2Deployer.deploy(salt,
 * initcode)` (adopt-existing if already there), and assert (a) the deployed address == the off-chain
 * CREATE2 prediction, (b) the RULING-B read-back (owner + both helper immutables == canonical), and
 * (c) the SAME (owner, agentSalt) yields the SAME account address on every chain (FP-g determinism).
 *
 * Pre-req: `fp4-bootstrap-singletons.mts` has pinned the deployer + helpers (same address everywhere);
 * set LEASH_CREATE2_DEPLOYER_ADDR / LEASH_SIGNING_HELPER_ADDR / LEASH_DECODE_HELPER_ADDR in backend/.env.
 * Run: `npx tsx scripts/fp4-live-matrix.mts [chainKey...]`. SPENDS real testnet gas (owner-authorized).
 */
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, defineChain, parseEventLogs, keccak256, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { buildV5Initcode, ownerScopedSalt, predictCreate2Address } from '../src/chain/v5-initcode.js';
import { create2DeployerAbi, leashAccountV5ReadAbi } from '../src/chain/abis.js';

/** Poll a read until the predicate holds — LB public RPCs (Base drpc) lag read-after-write and
 * route each eth_call to a different replica, so a just-deployed account can momentarily read 0x. */
async function pollRead<T>(read: () => Promise<T>, ok: (v: T) => boolean, tries = 15, delayMs = 2000): Promise<T> {
  let last!: T;
  for (let i = 0; i < tries; i++) {
    try {
      last = await read();
      if (ok(last)) return last;
    } catch {
      /* transient (zero-data from a lagging replica) — retry */
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return last;
}

function env(key: string): string {
  if (process.env[key]) return process.env[key] as string;
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const t = line.trim();
    if (t.startsWith(`${key}=`)) return t.slice(key.length + 1).replace(/^"|"$/g, '');
  }
  throw new Error(`missing ${key} in backend/.env`);
}

const DEPLOYER = env('LEASH_CREATE2_DEPLOYER_ADDR') as Hex;
const SIGNING_HELPER = env('LEASH_SIGNING_HELPER_ADDR') as Hex;
const DECODE_HELPER = env('LEASH_DECODE_HELPER_ADDR') as Hex;

interface ChainSpec { key: string; name: string; chainId: number; rpcEnv: string }
const CHAINS: ChainSpec[] = [
  { key: '0g', name: '0G Galileo', chainId: 16602, rpcEnv: 'ZERO_G_RPC' },
  { key: 'base', name: 'Base Sepolia', chainId: 84532, rpcEnv: 'BASE_SEPOLIA_RPC' },
  { key: 'arb', name: 'Arbitrum Sepolia', chainId: 421614, rpcEnv: 'ARBITRUM_SEPOLIA_RPC' },
  { key: 'eth', name: 'Ethereum Sepolia', chainId: 11155111, rpcEnv: 'ETHEREUM_SEPOLIA_RPC' },
];

// A fixed drill owner + agentSalt so the predicted account address is identical on every chain.
const DRILL_OWNER = '0x00000000000000000000000000000000000000A1' as Hex;
const DRILL_SESSION = '0x00000000000000000000000000000000000000B2' as Hex;
const DRILL_GUARDIAN = '0x00000000000000000000000000000000000000C3' as Hex;
const AGENT_SALT = `0x${'a5'.repeat(32)}` as Hex;

async function runChain(spec: ChainSpec): Promise<{ account: Hex; adopted: boolean }> {
  const rpc = env(spec.rpcEnv);
  const opsPkRaw = env('OPS_PRIVATE_KEY');
  const ops = privateKeyToAccount((opsPkRaw.startsWith('0x') ? opsPkRaw : `0x${opsPkRaw}`) as Hex);
  const chain = defineChain({ id: spec.chainId, name: spec.name, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const wallet = createWalletClient({ chain, transport: http(rpc), account: ops });

  const policy = { perTransferCap: 0n, windowCap: 0n, windowSeconds: 3600, expiresAt: 4102444800 }; // 2100-01-01
  const initcode = buildV5Initcode({
    ownerAddr: DRILL_OWNER, guardianAddr: DRILL_GUARDIAN, sessionKeyAddr: DRILL_SESSION,
    policy, allowlist: [], timelockDelay: 0,
    signingHelperAddr: SIGNING_HELPER, decodeHelperAddr: DECODE_HELPER,
  });
  const salt = ownerScopedSalt(DRILL_OWNER, AGENT_SALT);
  const predicted = predictCreate2Address(DEPLOYER, salt, initcode);

  // On-chain predict cross-check.
  const onchainPredict = (await pub.readContract({ address: DEPLOYER, abi: create2DeployerAbi, functionName: 'predict', args: [salt, keccak256(initcode)] })) as Hex;
  if (onchainPredict.toLowerCase() !== predicted.toLowerCase()) throw new Error(`predict mismatch: off-chain ${predicted} != on-chain ${onchainPredict}`);

  let account: Hex; let adopted = false;
  const existing = await pub.getCode({ address: predicted });
  if (existing && existing !== '0x') {
    account = predicted; adopted = true;
  } else {
    const hash = await wallet.writeContract({ address: DEPLOYER, abi: create2DeployerAbi, functionName: 'deploy', args: [salt, initcode] });
    const rc = await pub.waitForTransactionReceipt({ hash });
    const logs = rc.logs.filter((l) => l.address.toLowerCase() === DEPLOYER.toLowerCase());
    const deployed = parseEventLogs({ abi: create2DeployerAbi, logs, eventName: 'Deployed' })[0];
    if (!deployed) throw new Error('no Deployed event');
    account = deployed.args.account as Hex;
  }
  if (account.toLowerCase() !== predicted.toLowerCase()) throw new Error(`deployed ${account} != predicted ${predicted}`);

  // RULING-B read-back (polled — LB RPC read-after-write lag can briefly return 0x per-call).
  const nonEmpty = (v: Hex) => typeof v === 'string' && v.length === 42 && v !== '0x';
  const owner = await pollRead(() => pub.readContract({ address: account, abi: leashAccountV5ReadAbi, functionName: 'owner' }) as Promise<Hex>, nonEmpty);
  const sh = await pollRead(() => pub.readContract({ address: account, abi: leashAccountV5ReadAbi, functionName: 'signingHelper' }) as Promise<Hex>, nonEmpty);
  const dh = await pollRead(() => pub.readContract({ address: account, abi: leashAccountV5ReadAbi, functionName: 'decodeHelper' }) as Promise<Hex>, nonEmpty);
  if (owner.toLowerCase() !== DRILL_OWNER.toLowerCase()) throw new Error(`owner read-back ${owner} != ${DRILL_OWNER}`);
  if (sh.toLowerCase() !== SIGNING_HELPER.toLowerCase()) throw new Error(`signingHelper read-back ${sh} != ${SIGNING_HELPER}`);
  if (dh.toLowerCase() !== DECODE_HELPER.toLowerCase()) throw new Error(`decodeHelper read-back ${dh} != ${DECODE_HELPER}`);

  return { account, adopted };
}

const selected = process.argv.slice(2);
const chains = selected.length ? CHAINS.filter((c) => selected.includes(c.key)) : CHAINS;
const results: Record<string, { account: Hex; adopted: boolean }> = {};
for (const spec of chains) {
  results[spec.name] = await runChain(spec);
  console.log(`✅ ${spec.name}: account=${results[spec.name].account} ${results[spec.name].adopted ? '(adopted)' : '(deployed)'} — read-back OK`);
}

console.log('\n=== FP-4 P1 DEPLOY-PATH DETERMINISM ===');
const addrs = Object.values(results).map((r) => r.account);
const same = addrs.every((a) => a.toLowerCase() === addrs[0].toLowerCase());
console.log(`account address: ${addrs[0]} ${same ? '✅ identical on all chains (FP-g)' : '❌ DIVERGED'}`);
process.exit(same ? 0 : 1);
