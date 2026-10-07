// B1 (HACKATHON-RH2) — deploy the PRODUCTION-bytecode deterministic V4 factory to
// Robinhood Chain testnet (46630) at the SAME CREATE2 address as the rest of the
// fleet: 0x9C10b48748Da1cA0CEE5AD7DA0725490A7d5E46f. This is SE-9 exactly as the
// roadmap meant it — existing agents onboard to RH at their SAME address, because
// RH now runs the byte-exact `main` factory (not the price-band demo factory).
//
// Idempotent: skips if the factory already carries code. Asserts the built artifact
// predicts the expected address BEFORE sending, and the deployed runtime codehash
// equals the prod codehash 0x4771f057…f325. Emits a D1 drill JSON.
//
// Run: cd backend && npx tsx scripts/rh-deploy-prod-factory.ts
// RPC = local relay (contracts/rpc-relay.cjs on :8899) to dodge viem TLS BadRecordMac.
import { readFileSync, writeFileSync } from 'node:fs';
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  stringToHex,
  getCreate2Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

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

const RPC = 'http://127.0.0.1:8899'; // relay → RH testnet
const CHAIN_ID = 46630;
const CREATE2_DEPLOYER = '0x4e59b44847b379578588920cA78FbF26c0B4956C' as Hex;
const FACTORY_SALT = keccak256(stringToHex('LEASH-V4-DETERMINISTIC-FACTORY-v1'));
const EXPECTED_ADDR = '0x9C10b48748Da1cA0CEE5AD7DA0725490A7d5E46f';
const EXPECTED_CODEHASH = '0x4771f0574001ae3435299d296f76e60546fe5de413940aab18e8a6faf904f325';

// Prod-bytecode artifact built from `main` in the worktree (/tmp/leash-main-wt @ c3e46ce).
const artifact = JSON.parse(
  readFileSync(
    '/tmp/leash-main-wt/contracts/out/LeashAccountV4FactoryDeterministic.sol/LeashAccountV4FactoryDeterministic.json',
    'utf8',
  ),
) as { bytecode: { object: Hex } };
const FACTORY_INITCODE = artifact.bytecode.object;
const FACTORY_ADDR = getCreate2Address({ from: CREATE2_DEPLOYER, salt: FACTORY_SALT, bytecodeHash: keccak256(FACTORY_INITCODE) });

if (FACTORY_ADDR.toLowerCase() !== EXPECTED_ADDR.toLowerCase()) {
  throw new Error(`FATAL: built artifact predicts ${FACTORY_ADDR}, expected ${EXPECTED_ADDR} — wrong bytecode, aborting.`);
}

const ops = privateKeyToAccount(requireEnv('OPS_PRIVATE_KEY') as Hex);
const pub = createPublicClient({ transport: http(RPC) });
const wallet = createWalletClient({ account: ops, transport: http(RPC) });

async function waitForCode(addr: Hex): Promise<Hex | null> {
  for (let i = 0; i < 20; i++) {
    const code = await pub.getCode({ address: addr });
    if (code && code !== '0x') return code;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return null;
}

async function main() {
  console.log(`B1 RH prod factory · chain ${CHAIN_ID} · predicted==expected ${FACTORY_ADDR} ✓ · ops ${ops.address}`);

  let deployTx: Hex | 'already-deployed' = 'already-deployed';
  const existing = await pub.getCode({ address: FACTORY_ADDR });
  if (existing && existing !== '0x') {
    console.log(`SKIP: ${FACTORY_ADDR} already carries code`);
  } else {
    console.log(`DEPLOY: sending CREATE2 factory tx from ${ops.address}…`);
    deployTx = await wallet.sendTransaction({
      chain: null,
      to: CREATE2_DEPLOYER,
      data: (FACTORY_SALT + FACTORY_INITCODE.slice(2)) as Hex,
    });
    await pub.waitForTransactionReceipt({ hash: deployTx });
    console.log(`  mined tx ${deployTx}`);
  }

  const code = await waitForCode(FACTORY_ADDR);
  if (!code) throw new Error('FATAL: factory code not visible after deploy');
  const codehash = keccak256(code);
  const codehashMatch = codehash.toLowerCase() === EXPECTED_CODEHASH.toLowerCase();

  // D1 assertions
  const checks = [
    { check: 'predicted address == expected', ok: FACTORY_ADDR.toLowerCase() === EXPECTED_ADDR.toLowerCase(), detail: FACTORY_ADDR },
    { check: 'code present at 0x9C10…E46f on RH', ok: true, detail: `${code.length} bytes` },
    { check: 'runtime codehash == prod codehash', ok: codehashMatch, detail: `${codehash} ${codehashMatch ? 'MATCH ✓' : 'MISMATCH!!'}` },
  ];
  const pass = checks.filter((c) => c.ok).length;

  const evidence = {
    drill: 'B1 — prod-bytecode deterministic V4 factory on Robinhood Chain (HACKATHON-RH2 D1)',
    chainId: CHAIN_ID,
    factoryAddr: FACTORY_ADDR,
    expectedAddr: EXPECTED_ADDR,
    expectedCodehash: EXPECTED_CODEHASH,
    actualCodehash: codehash,
    codehashMatch,
    deployTx,
    ops: ops.address,
    score: `${pass}/${checks.length}`,
    checks,
    at: new Date().toISOString(),
  };
  writeFileSync(new URL('../../docs/evidence/rh-prod-factory-d1.json', import.meta.url), JSON.stringify(evidence, null, 2));
  console.log(`\n${pass}/${checks.length} passed · evidence → docs/evidence/rh-prod-factory-d1.json`);
  for (const c of checks) console.log(`  ${c.ok ? 'pass' : 'FAIL'}  ${c.check} — ${c.detail}`);
  if (pass < checks.length) process.exit(1);
}

main().catch((e) => { console.error('B1 error:', e); process.exit(1); });
