// Stage-E CLOSE deploy — deterministic V4 factory (final SE-9 bytecode) to the two
// remaining home chains 0G Galileo (16602) + Base Sepolia (84532), at the SAME CREATE2
// address 0x9C10b48748Da1cA0CEE5AD7DA0725490A7d5E46f as Arb/Eth Sepolia. Idempotent:
// skips a chain already carrying the factory. Verifies the deployed runtime codehash
// equals the SE-9 wall 0x4771f057…f325. Reads backend/.env. No secrets printed.
import { readFileSync } from 'node:fs';
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  stringToHex,
  getCreate2Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { zeroGChain } from '../src/chain/ops.js';
import { confirmReceipt, withFlakeRetry, isFlake } from './drill-common.js';

const env: Record<string, string> = {};
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const t = line.trim();
  if (t && !t.startsWith('#') && t.includes('=')) {
    const i = t.indexOf('=');
    env[t.slice(0, i)] = t.slice(i + 1).replace(/^"|"$/g, '');
  }
}
function requireEnv(n: string): string {
  const v = env[n];
  if (!v) throw new Error(`requires ${n} in backend/.env`);
  return v;
}

const CREATE2_DEPLOYER = '0x4e59b44847b379578588920cA78FbF26c0B4956C' as Hex;
const FACTORY_SALT = keccak256(stringToHex('LEASH-V4-DETERMINISTIC-FACTORY-v1'));
const EXPECTED_ADDR = '0x9C10b48748Da1cA0CEE5AD7DA0725490A7d5E46f';
const EXPECTED_CODEHASH = '0x4771f0574001ae3435299d296f76e60546fe5de413940aab18e8a6faf904f325';

const artifact = JSON.parse(
  readFileSync(
    new URL('../../contracts/out/LeashAccountV4FactoryDeterministic.sol/LeashAccountV4FactoryDeterministic.json', import.meta.url),
    'utf8',
  ),
) as { bytecode: { object: Hex } };
const FACTORY_INITCODE = artifact.bytecode.object;
const FACTORY_ADDR = getCreate2Address({ from: CREATE2_DEPLOYER, salt: FACTORY_SALT, bytecodeHash: keccak256(FACTORY_INITCODE) });

if (FACTORY_ADDR.toLowerCase() !== EXPECTED_ADDR.toLowerCase()) {
  throw new Error(`FATAL: built artifact predicts ${FACTORY_ADDR}, expected ${EXPECTED_ADDR} — wrong bytecode, aborting.`);
}

const ops = privateKeyToAccount(requireEnv('OPS_PRIVATE_KEY') as Hex);

interface C { name: string; chainId: number; rpc: string; pub: PublicClient; wallet: WalletClient; gasFloor: bigint }
function ctx(name: string, chainId: number, rpc: string, gasFloor: bigint): C {
  const chain = zeroGChain(rpc, chainId);
  return {
    name, chainId, rpc, gasFloor,
    pub: createPublicClient({ chain, transport: http(rpc) }),
    wallet: createWalletClient({ chain, transport: http(rpc), account: ops }),
  };
}

const CHAINS: C[] = [
  ctx('0g-16602', 16602, requireEnv('ZERO_G_RPC'), 2_000_000_000n), // 0G 2-gwei floor
  ctx('base-84532', 84532, requireEnv('BASE_SEPOLIA_RPC'), 0n),
];

async function waitForCode(c: C, addr: Hex): Promise<string | null> {
  for (let i = 0; i < 15; i++) {
    try { const code = await c.pub.getCode({ address: addr }); if (code && code !== '0x') return code; }
    catch (err) { if (!isFlake(err)) throw err; }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return null;
}

async function deploy(c: C): Promise<void> {
  const existing = await withFlakeRetry(() => c.pub.getCode({ address: FACTORY_ADDR }), { label: `${c.name} getCode` });
  if (existing && existing !== '0x') {
    const h = keccak256(existing as Hex);
    console.log(`SKIP  ${c.name}: already deployed; codehash ${h} ${h === EXPECTED_CODEHASH ? 'MATCH' : 'MISMATCH!!'}`);
    return;
  }
  // gas floor for 0G: fetch base fee, enforce >= 2 gwei
  const fees: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint } =
    c.gasFloor > 0n ? { maxFeePerGas: c.gasFloor * 2n, maxPriorityFeePerGas: c.gasFloor } : {};
  console.log(`DEPLOY ${c.name}: sending CREATE2 factory tx from ${ops.address}…`);
  const hash = await c.wallet.sendTransaction({
    chain: c.wallet.chain,
    account: ops,
    to: CREATE2_DEPLOYER,
    data: (FACTORY_SALT + FACTORY_INITCODE.slice(2)) as Hex,
    ...fees,
  });
  await confirmReceipt(c.pub, hash);
  const code = await waitForCode(c, FACTORY_ADDR);
  if (!code) { console.log(`FLAKE ${c.name}: code not visible (tx ${hash})`); return; }
  const h = keccak256(code as Hex);
  console.log(`DONE  ${c.name}: deployed at ${FACTORY_ADDR} (tx ${hash}); codehash ${h} ${h === EXPECTED_CODEHASH ? 'MATCH ✓' : 'MISMATCH!!'}`);
}

(async () => {
  console.log(`factory=${FACTORY_ADDR} (predicted==expected ✓) ops=${ops.address}`);
  for (const c of CHAINS) {
    try { await deploy(c); } catch (e) { console.log(`ERROR ${c.name}: ${(e as Error).message}`); }
  }
})();
