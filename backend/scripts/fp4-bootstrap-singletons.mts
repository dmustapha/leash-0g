/**
 * Stage F′ FP-4 P1 — DETERMINISTIC SINGLETON BOOTSTRAP (build-order step 5).
 *
 * Deploys the three pinned singletons — Create2Deployer, SigningLib, DecodeLib — at the SAME
 * address on every chain, via the standard keyless deterministic-deployment proxy
 * (0x4e59b44847b379578588920cA78FbF26c0B4956C) with FIXED salts. Because the proxy is at the
 * same address on all chains (verified present on 0G/Base/Arb/Eth) and each singleton's initcode
 * is byte-identical (no constructor args), the CREATE2 address — f(proxy, salt, keccak(initcode))
 * — is identical everywhere. That is the determinism anchor the whole V5 onboarding rests on:
 * deployer + helpers same-address ⇒ V5 account initcode byte-identical ⇒ same account address
 * cross-chain (FP-g / BR-1). Idempotent: skips a singleton already present at its predicted address.
 *
 * Run: `npx tsx scripts/fp4-bootstrap-singletons.mts [chainKey...]` (default: all). Reads backend/.env.
 * SPENDS real testnet gas — a deliberate, owner-authorized op. Prints the canonical addresses to pin
 * in config/.env (LEASH_CREATE2_DEPLOYER_ADDR / LEASH_SIGNING_HELPER_ADDR / LEASH_DECODE_HELPER_ADDR).
 */
import { readFileSync } from 'node:fs';
import {
  createPublicClient, createWalletClient, http, defineChain, encodePacked, keccak256, getAddress,
  concatHex, type Hex, type Abi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const STD_PROXY = '0x4e59b44847b379578588920cA78FbF26c0B4956C' as Hex;

// Fixed salts — any constant works; these are human-legible and versioned.
const SALTS = {
  Create2Deployer: keccak256(encodePacked(['string'], ['leash.create2deployer.v1'])),
  SigningLib: keccak256(encodePacked(['string'], ['leash.signinglib.v1'])),
  DecodeLib: keccak256(encodePacked(['string'], ['leash.decodelib.v1'])),
} as const;

/** Poll getCode until present — load-balanced public RPCs (Base drpc) lag read-after-write. */
async function pollCode(read: () => Promise<Hex | undefined>, tries = 15, delayMs = 2000): Promise<Hex | undefined> {
  let last: Hex | undefined;
  for (let i = 0; i < tries; i++) {
    last = await read();
    if (last && last !== '0x') return last;
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

function creationCode(name: string): Hex {
  const art = JSON.parse(
    readFileSync(new URL(`../../contracts/out/${name}.sol/${name}.json`, import.meta.url), 'utf8'),
  ) as { abi: Abi; bytecode: { object: Hex } };
  return art.bytecode.object;
}

/** The CREATE2 address a singleton lands at under the std proxy with its fixed salt. */
function predictSingleton(salt: Hex, initcode: Hex): Hex {
  const digest = keccak256(
    encodePacked(['bytes1', 'address', 'bytes32', 'bytes32'], ['0xff', STD_PROXY, salt, keccak256(initcode)]),
  );
  return getAddress(`0x${digest.slice(-40)}`);
}

interface ChainSpec { key: string; name: string; chainId: number; rpcEnv: string }
const CHAINS: ChainSpec[] = [
  { key: '0g', name: '0G Galileo', chainId: 16602, rpcEnv: 'ZERO_G_RPC' },
  { key: 'base', name: 'Base Sepolia', chainId: 84532, rpcEnv: 'BASE_SEPOLIA_RPC' },
  { key: 'arb', name: 'Arbitrum Sepolia', chainId: 421614, rpcEnv: 'ARBITRUM_SEPOLIA_RPC' },
  { key: 'eth', name: 'Ethereum Sepolia', chainId: 11155111, rpcEnv: 'ETHEREUM_SEPOLIA_RPC' },
];

const SINGLETONS = ['Create2Deployer', 'SigningLib', 'DecodeLib'] as const;
type SingletonName = (typeof SINGLETONS)[number];

async function bootstrapChain(spec: ChainSpec): Promise<Record<SingletonName, Hex>> {
  const rpc = env(spec.rpcEnv);
  const opsPkRaw = env('OPS_PRIVATE_KEY');
  const ops = privateKeyToAccount((opsPkRaw.startsWith('0x') ? opsPkRaw : `0x${opsPkRaw}`) as Hex);
  const chain = defineChain({ id: spec.chainId, name: spec.name, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const wallet = createWalletClient({ chain, transport: http(rpc), account: ops });

  // The proxy itself MUST be present (verified on all 4 chains); refuse the chain otherwise.
  const proxyCode = await pub.getCode({ address: STD_PROXY });
  if (!proxyCode || proxyCode === '0x') throw new Error(`std CREATE2 proxy absent on ${spec.name} — cannot pin singletons deterministically`);

  const out = {} as Record<SingletonName, Hex>;
  for (const name of SINGLETONS) {
    const salt = SALTS[name];
    const initcode = creationCode(name);
    const predicted = predictSingleton(salt, initcode);
    out[name] = predicted;
    const existing = await pub.getCode({ address: predicted });
    if (existing && existing !== '0x') {
      console.log(`  ${name} already at ${predicted} (skip)`);
      continue;
    }
    // Arachnid proxy calldata: salt (32B) ++ initcode. It create2's and returns the address.
    const hash = await wallet.sendTransaction({ to: STD_PROXY, data: concatHex([salt, initcode]) });
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== 'success') throw new Error(`${name} proxy tx reverted (${hash}) on ${spec.name}`);
    const after = await pollCode(() => pub.getCode({ address: predicted }));
    if (!after || after === '0x') throw new Error(`${name} not deployed at predicted ${predicted} on ${spec.name}`);
    console.log(`  ${name} → ${predicted} (deployed ${hash.slice(0, 10)}..)`);
  }
  return out;
}

const selected = process.argv.slice(2);
const chains = selected.length ? CHAINS.filter((c) => selected.includes(c.key)) : CHAINS;
const perChain: Record<string, Record<SingletonName, Hex>> = {};
for (const spec of chains) {
  console.log(`\n[${spec.name}]`);
  perChain[spec.name] = await bootstrapChain(spec);
}

// Cross-chain same-address assertion — the determinism proof.
console.log('\n=== CANONICAL SINGLETON ADDRESSES (pin these) ===');
let allSame = true;
for (const name of SINGLETONS) {
  const addrs = Object.values(perChain).map((m) => m[name]);
  const same = addrs.every((a) => a.toLowerCase() === addrs[0].toLowerCase());
  allSame &&= same;
  console.log(`${name}: ${addrs[0]} ${same ? '✅ identical on all chains' : `❌ DIVERGED ${JSON.stringify(perChain)}`}`);
}
const canon = Object.values(perChain)[0];
if (allSame && canon) {
  console.log('\n# .env / config pins:');
  console.log(`LEASH_CREATE2_DEPLOYER_ADDR=${canon.Create2Deployer}`);
  console.log(`LEASH_SIGNING_HELPER_ADDR=${canon.SigningLib}`);
  console.log(`LEASH_DECODE_HELPER_ADDR=${canon.DecodeLib}`);
}
process.exit(allSame ? 0 : 1);
