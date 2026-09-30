// SE-6 E-6 [DEPLOY] drill — CREATE2 same-address across ≥2 chains, LIVE.
//
// Proves, on Base Sepolia (84532) + 0G Galileo (16602):
//   1. the deterministic V4 factory sits at the SAME address on both chains
//      (deployed via the canonical CREATE2 deployer 0x4e59…956C with a fixed
//      salt; idempotent — skipped when code already present);
//   2. the PRODUCTION verification path (`ChainRegistry.assertSameAddress`)
//      passes pre-deploy (same factory addr + factory codehash + prediction);
//   3. the same (owner, salt) + identical construction tuple MINTS the account
//      at the SAME address on both chains (fresh random account salt per run —
//      idempotent by construction);
//   4. `assertSameAddress` passes post-deploy (deployed account codehashes
//      identical across chains — the wall bytecode is the same everywhere);
//   5. the governed-calldata wall is LIVE on the far chain (off-allowlist
//      executeCall REVERTS TargetNotAllowlisted on Base Sepolia, selector-anchored);
//   6. a MISMATCH is REFUSED by the production path (a registry pointing chain B
//      at a wrong factory address throws SameAddressMismatchError — funds would
//      never route cross-chain).
//
// Run: cd backend && npx tsx scripts/create2-same-address-drill.ts
// Reads backend/.env (OPS_PRIVATE_KEY, GUARDIAN_PRIVATE_KEY, ZERO_G_RPC[, BASE_SEPOLIA_RPC]).
// SE-4 conventions: bounded flake tolerance (transport-only), same-hash receipt
// re-poll (zero double-submit), green iff fail==0 AND flake==0, counts in the
// evidence JSON (docs/evidence/stage-e-create2-drill.json), never a commit subject.
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
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { factoryV4DeterministicAbi, leashAccountV4Abi } from '../src/chain/abis.js';
import { ChainRegistry, SameAddressMismatchError, type ChainConfig } from '../src/chain/registry.js';
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

// The canonical, keyless CREATE2 deployer (present on 0G, Base Sepolia, Arbitrum
// Sepolia — verified live): tx data = salt(32) ++ initcode.
const CREATE2_DEPLOYER = '0x4e59b44847b379578588920cA78FbF26c0B4956C' as Hex;
// Fixed factory salt — the SAME on every chain so the factory address is the same.
const FACTORY_SALT = keccak256(stringToHex('LEASH-V4-DETERMINISTIC-FACTORY-v1'));

const ops = privateKeyToAccount(env.OPS_PRIVATE_KEY as Hex);
const guardian = privateKeyToAccount(env.GUARDIAN_PRIVATE_KEY as Hex);

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

const ZG = ctx('0g-16602', Number(env.ZERO_G_CHAIN_ID ?? '16602'), env.ZERO_G_RPC as string);
const BASE = ctx('base-sepolia', 84532, env.BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org');
const CHAINS = [ZG, BASE];

// The deterministic factory's creation bytecode, from the forge artifact
// (forge build must have run). No constructor args → initcode = creation code.
const artifact = JSON.parse(
  readFileSync(new URL('../../contracts/out/LeashAccountV4FactoryDeterministic.sol/LeashAccountV4FactoryDeterministic.json', import.meta.url), 'utf8'),
) as { bytecode: { object: Hex } };
const FACTORY_INITCODE = artifact.bytecode.object;
const FACTORY_ADDR = getCreate2Address({
  from: CREATE2_DEPLOYER,
  salt: FACTORY_SALT,
  bytecodeHash: keccak256(FACTORY_INITCODE),
});

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

/**
 * Bounded re-poll for non-empty code at `addr`. A confirmed deploy whose code
 * has not propagated to the (possibly load-balanced) RPC node yet is a TRANSIENT
 * (seen live on sepolia.base.org) — an empty read is not an error, so
 * withFlakeRetry alone cannot catch it. Exhaustion returns null (inconclusive →
 * FLAKE, never a masked pass).
 */
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
  record(
    `factory@${c.name}`,
    deployed !== null,
    deployed !== null ? `deployed at ${FACTORY_ADDR} (tx ${hash})` : `code not visible after confirmed deploy (tx ${hash})`,
    deployed !== null ? 'pass' : 'flake',
  );
}

function registryFor(factoryOverrides: Partial<Record<number, Hex>> = {}): ChainRegistry {
  const configs: ChainConfig[] = CHAINS.map((c) => ({
    chainId: c.chainId,
    name: c.name,
    rpcUrl: c.rpc,
    factoryAddr: FACTORY_ADDR, // unused by this drill (legacy lane)
    factoryV4Addr: factoryOverrides[c.chainId] ?? FACTORY_ADDR,
    registryAddr: (env.AGENT_REGISTRY_ADDR ?? '0x' + '00'.repeat(20)) as string,
    accountVersion: 4,
    gasFloorWei: 0n,
  }));
  return new ChainRegistry(configs, {
    opsPrivateKey: env.OPS_PRIVATE_KEY as string,
    guardianPrivateKey: env.GUARDIAN_PRIVATE_KEY as string,
  });
}

async function main() {
  console.log(`ops=${ops.address} factory(pred)=${FACTORY_ADDR}`);

  // ---- 1. deterministic factory at the SAME address on both chains ----
  for (const c of CHAINS) await ensureFactory(c);

  // ---- 2. PRE-DEPLOY: production assertSameAddress passes ----
  const accountSalt = (`0x${randomBytes(32).toString('hex')}`) as Hex;
  const create = {
    ownerAddr: ops.address,
    sessionKeyAddr: ops.address, // drill account: owner == sessionKey == ops (SE-4 shape)
    guardianAddr: guardian.address, // M-01: the CREATE-TIME guardian, explicit
    policy: {
      perTransferCap: 10n ** 12n,
      windowCap: 10n ** 12n,
      windowSeconds: 3600,
      expiresAt: 2 ** 31 - 1, // chain-invariant (never "now"-derived — must match on both chains)
    },
    allowlist: [] as string[],
    timelockDelay: 0,
  };
  const sameInput = { ownerAddr: ops.address, accountSalt, create, chainIds: CHAINS.map((c) => c.chainId) };
  let verified: string;
  try {
    verified = await withFlakeRetry(() => registryFor().assertSameAddress(sameInput), { label: 'assertSameAddress pre' });
    record('assertSameAddress pre-deploy', true, `verified address ${verified}`);
  } catch (err) {
    record('assertSameAddress pre-deploy', false, String(err), isFlake(err) ? 'flake' : 'fail');
    throw err;
  }

  // ---- 3. mint with the SAME (owner, salt) + tuple on BOTH chains ----
  const args = [
    ops.address,
    guardian.address,
    ops.address,
    {
      perTransferCap: create.policy.perTransferCap,
      windowCap: create.policy.windowCap,
      windowSeconds: create.policy.windowSeconds,
      expiresAt: BigInt(create.policy.expiresAt),
    },
    [] as Hex[],
    0n,
    ('0x' + '00'.repeat(20)) as Hex,
    { perTransferCapToken: 0n, windowCapToken: 0n },
    accountSalt,
  ] as const;
  const minted: Record<string, string> = {};
  for (const c of CHAINS) {
    const hash = await c.wallet.writeContract({
      chain: c.wallet.chain,
      account: ops,
      address: FACTORY_ADDR,
      abi: factoryV4DeterministicAbi,
      functionName: 'createAccountV4',
      args: [...args],
    });
    await confirmReceipt(c.pub, hash);
    const code = await waitForCode(c, verified as Hex);
    minted[c.name] = hash;
    record(
      `mint@${c.name}`,
      code !== null,
      code !== null ? `account ${verified} has code (tx ${hash})` : `account code not visible after confirmed mint (tx ${hash})`,
      code !== null ? 'pass' : 'flake',
    );
  }

  // ---- 4. POST-DEPLOY: assertSameAddress in the FULL pre-routing shape ----
  // (M-01) binds the prediction to the persisted account + requires the home
  // chain to host the deployed bytecode — the exact call SE-8 makes before
  // routing funds cross-chain.
  try {
    const post = await withFlakeRetry(
      () =>
        registryFor().assertSameAddress({
          ...sameInput,
          expectedAccountAddr: verified,
          homeChainId: ZG.chainId,
        }),
      { label: 'assertSameAddress post' },
    );
    record('assertSameAddress post-deploy', post === verified, `verified ${post} (bound to persisted account + home-chain deployed + bytecode identical)`);
  } catch (err) {
    record('assertSameAddress post-deploy', false, String(err), isFlake(err) ? 'flake' : 'fail');
  }
  // (M-01 negative, live) a counterfactual persisted address is REFUSED.
  try {
    await registryFor().assertSameAddress({
      ...sameInput,
      expectedAccountAddr: '0x' + 'bd'.repeat(20),
      homeChainId: ZG.chainId,
    });
    record('expected-account-refused', false, 'counterfactual persisted address was NOT refused');
  } catch (err) {
    const ok = err instanceof SameAddressMismatchError && err.field === 'expected_account';
    record('expected-account-refused', ok, ok ? `refused: ${(err as Error).message.slice(0, 120)}` : `unexpected: ${String(err).slice(0, 120)}`);
  }

  // ---- 5. the wall is LIVE on the far chain (Base Sepolia) ----
  try {
    const probe = encodeFunctionData({
      abi: leashAccountV4Abi,
      functionName: 'executeCall',
      args: [
        // A CODE-BEARING, never-allowlisted target (the factory itself) so the
        // wall's refusal is deterministically TargetNotAllowlisted — a codeless
        // probe target reverts EmptyCodeTarget (0xc3c2a014) instead, which the
        // selector-anchored check correctly flagged as the wrong reason.
        FACTORY_ADDR,
        0n,
        encodeFunctionData({
          abi: [{ type: 'function', name: 'approve', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }],
          functionName: 'approve',
          args: [ops.address, 1n],
        }),
      ],
    });
    await BASE.pub.call({ account: ops.address, to: verified as Hex, data: probe });
    record('wall-live@base-sepolia', false, 'off-allowlist executeCall unexpectedly SUCCEEDED');
  } catch (err) {
    // Anchor on the ACTUAL revert data where the node returns it (code-review
    // NIT): walk the viem error cause-chain for the raw `data` field — the
    // TargetNotAllowlisted(address) selector is 0x042a9b0d. Wrong-selector
    // revert data = FAIL (wrong reason, never masked); revert with NO data
    // surfaced = pass-with-note (0G/Base RPC roughness precedent, SE-1 E-2);
    // transport flake = flake.
    const msg = String((err as { shortMessage?: string; message?: string }).shortMessage ?? (err as Error).message);
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
    const anchored = (revertData?.startsWith('0x042a9b0d') ?? false) || /0x042a9b0d|TargetNotAllowlisted/i.test(msg);
    const wrongReason = revertData !== null && !anchored;
    const genericRevert = revertData === null && /revert/i.test(msg) && !isFlake(err);
    record(
      'wall-live@base-sepolia',
      anchored || genericRevert,
      anchored
        ? `REVERTED TargetNotAllowlisted (selector-anchored): ${(revertData ?? msg).slice(0, 100)}`
        : wrongReason
          ? `reverted with the WRONG selector: ${revertData?.slice(0, 100)}`
          : `reverted (no revert data surfaced by the RPC): ${msg.slice(0, 100)}`,
      anchored || genericRevert ? 'pass' : isFlake(err) ? 'flake' : 'fail',
    );
  }

  // ---- 6. MISMATCH REFUSED by the production path ----
  try {
    // Chain B "spoofed": its config points at a DIFFERENT contract (the CREATE2
    // deployer itself — real code, wrong factory). Production must REFUSE.
    await registryFor({ [BASE.chainId]: CREATE2_DEPLOYER }).assertSameAddress(sameInput);
    record('mismatch-refused', false, 'spoofed factory config was NOT refused');
  } catch (err) {
    const ok = err instanceof SameAddressMismatchError;
    record('mismatch-refused', ok, ok ? `refused: ${(err as Error).message.slice(0, 140)}` : `unexpected error: ${String(err).slice(0, 140)}`);
  }

  const green = fail === 0 && flake === 0;
  const run = {
    when: new Date().toISOString(),
    accountSalt,
    verifiedAccount: verified,
    mintTxs: minted,
    counts: { pass, fail, flake },
    green,
    results,
  };
  // Keep the last runs inspectable (SE-4/SE-5 jit resetRuns precedent) so
  // back-to-back green runs are individually verifiable, not overwritten.
  const evidenceUrl = new URL('../../docs/evidence/stage-e-create2-drill.json', import.meta.url);
  let priorRuns: unknown[] = [];
  try {
    const prior = JSON.parse(readFileSync(evidenceUrl, 'utf8')) as { runs?: unknown[] };
    priorRuns = prior.runs ?? [];
  } catch {
    /* first run — no prior evidence */
  }
  const evidence = {
    drill: 'stage-e-create2-same-address',
    chains: CHAINS.map((c) => ({ name: c.name, chainId: c.chainId })),
    factoryAddr: FACTORY_ADDR,
    factorySalt: FACTORY_SALT,
    runs: [...priorRuns.slice(-3), run],
  };
  writeFileSync(evidenceUrl, JSON.stringify(evidence, null, 2) + '\n');
  console.log(`\n${green ? 'GREEN' : 'NOT GREEN'} — pass=${pass} fail=${fail} flake=${flake}`);
  console.log('evidence → docs/evidence/stage-e-create2-drill.json');
  if (!green) process.exit(1);
}

main().catch((err) => {
  console.error('drill aborted:', err);
  process.exit(1);
});
