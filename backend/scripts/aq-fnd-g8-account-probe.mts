/**
 * AQ-FND — G-8 ACCOUNT-LEVEL: a REAL LeashAccountV6 minted through the PRODUCTION
 * backend path (ChainRegistry → LeashChainOps.deployAndRegister accountVersion:6) on
 * BOTH 0G Galileo and Base Sepolia with the SAME owner+salt+tuple, then verified by
 * the PRODUCTION `registry.assertSameAddress({accountVersion: 6, homeChainId})` LIVE.
 *
 * This is the remaining half of G-8 (the singleton dependency set was proven
 * same-address by aq-fnd-g8-xchain-probe.mts): the ACCOUNT lands at the same address
 * on both chains and the production verifier PASSES on the honest tuple and REFUSES
 * every tampered one (G-8 bar: 0 false same-address).
 *
 * Run:  cd /Users/MAC/leash/backend
 *       npx tsx scripts/aq-fnd-g8-account-probe.mts --send
 *   (omit --send to re-verify an already-minted pair recorded in the evidence JSON)
 *
 * Spends real testnet gas from the ops key on BOTH chains (V6 deploy ≈ 5M gas each).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ChainRegistry, SameAddressMismatchError, type ChainConfig } from '../src/chain/registry.js';

const OUT = '/Users/MAC/0g-fleet/docs/evidence/aq-fnd';
const STATE = `${OUT}/g8-account-results.json`;
const SEND = process.argv.includes('--send');

// ---- env (backend/.env, the SAME values production runs on) ----
const env: Record<string, string> = {};
for (const line of readFileSync('/Users/MAC/leash/backend/.env', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]!] = m[2]!;
}
const need = (k: string): string => {
  const v = env[k];
  if (!v) throw new Error(`missing ${k} in backend/.env`);
  return v;
};

const HOME_ID = 16602; // 0G Galileo
const DEST_ID = 84532; // Base Sepolia

// The five V6-pinned singletons are GLOBAL (same-address by construction).
const singletons = {
  create2DeployerAddr: need('LEASH_CREATE2_DEPLOYER_ADDR').toLowerCase(),
  signingHelperAddr: need('LEASH_SIGNING_HELPER_ADDR').toLowerCase(),
  decodeHelperAddr: need('LEASH_DECODE_HELPER_ADDR').toLowerCase(),
  policyHelperAddr: need('LEASH_POLICY_HELPER_ADDR').toLowerCase(),
  envelopeModuleAddr: need('LEASH_ENVELOPE_MODULE_ADDR').toLowerCase(),
  gasRepayDelegateAddr: need('LEASH_GAS_REPAY_DELEGATE_ADDR').toLowerCase(),
};

const configs: ChainConfig[] = [
  {
    chainId: HOME_ID,
    name: '0G Galileo',
    rpcUrl: need('ZERO_G_RPC'),
    registryAddr: need('AGENT_REGISTRY_ADDR'),
    accountVersion: 6,
    gasFloorWei: 2_000_000_000n,
    ...singletons,
  },
  {
    chainId: DEST_ID,
    name: 'Base Sepolia',
    rpcUrl: need('BASE_SEPOLIA_RPC'),
    registryAddr: need('AGENT_REGISTRY_BASE_ADDR'),
    accountVersion: 6,
    gasFloorWei: 0n,
    ...singletons,
  },
];

const registry = new ChainRegistry(configs, {
  opsPrivateKey: need('OPS_PRIVATE_KEY'),
  guardianPrivateKey: need('GUARDIAN_PRIVATE_KEY'),
});

type Row = { check: string; result: string; verdict: 'PASS' | 'FAIL' | 'INFO' };
const rows: Row[] = [];
const log = (r: Row) => {
  rows.push(r);
  console.log(`[${r.verdict.padEnd(4)}] ${r.check.padEnd(56)} ${r.result}`);
};

async function expectRefusal(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    log({ check: label, result: 'DID NOT REFUSE — false same-address', verdict: 'FAIL' });
  } catch (e) {
    const ok = e instanceof SameAddressMismatchError;
    log({
      check: label,
      result: `${ok ? e.field : 'wrong error type'}: ${(e as Error).message.slice(0, 90)}…`,
      verdict: ok ? 'PASS' : 'FAIL',
    });
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const ops = privateKeyToAccount(need('OPS_PRIVATE_KEY') as `0x${string}`);

  // ---- the shared create tuple (same on BOTH chains — it IS the CREATE2 preimage) ----
  // Persisted state lets a later --no-send run re-verify the SAME minted pair.
  type Minted = {
    ownerAddr: string;
    sessionKeyAddr: string;
    guardianAddr: string;
    accountSalt: string;
    accountAddr: string;
    initCodeHash: string;
    policy: { perTransferCap: string; windowCap: string; windowSeconds: number; expiresAt: number };
    allowlist: string[];
    timelockDelay: number;
    txs: Record<string, { createTx: string; registerTx: string; adopted: boolean }>;
  };
  let minted: Minted | null = null;
  if (existsSync(STATE)) {
    const prior = JSON.parse(readFileSync(STATE, 'utf8')) as { minted?: Minted };
    if (prior.minted) minted = prior.minted;
  }

  if (!minted && !SEND) throw new Error('no prior mint recorded — run with --send');

  if (!minted) {
    const sessionKey = privateKeyToAccount(generatePrivateKey());
    const tuple = {
      ownerAddr: ops.address,
      sessionKeyAddr: sessionKey.address,
      auditPubKey: `0x02${'11'.repeat(32)}`,
      name: 'aq-fnd g8 account probe',
      accountVersion: 6 as const,
      policy: {
        perTransferCap: 10n ** 15n, // 0.001 native — probe-scale
        windowCap: 2n * 10n ** 15n,
        windowSeconds: 3600,
        expiresAt: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
      },
      allowlist: [ops.address as string],
      timelockDelay: 60,
      accountSalt: `0x${randomBytes(32).toString('hex')}`,
    };

    // ---- mint through the PRODUCTION path on both chains, same salt+tuple ----
    const txs: Minted['txs'] = {};
    let addr: string | null = null;
    let initCodeHash: string | null = null;
    let guardianAddr: string | null = null;
    for (const chainId of [HOME_ID, DEST_ID]) {
      const lane = registry.getChainOps(chainId);
      const r = await lane.deployAndRegister(tuple);
      txs[String(chainId)] = { createTx: r.createTx, registerTx: r.registerTx, adopted: r.adopted ?? false };
      log({
        check: `V6 account minted on ${registry.getChainConfig(chainId).name} (production deployAndRegister)`,
        result: `addr ${r.accountAddr} · create ${r.createTx.slice(0, 14)}… · register ${r.registerTx.slice(0, 14)}…`,
        verdict: 'PASS',
      });
      if (addr && r.accountAddr.toLowerCase() !== addr.toLowerCase()) {
        log({ check: 'same account address across chains', result: `${addr} != ${r.accountAddr}`, verdict: 'FAIL' });
      }
      addr = r.accountAddr;
      initCodeHash = r.initCodeHash ?? null;
      guardianAddr = r.guardianAddr;
    }
    minted = {
      ownerAddr: tuple.ownerAddr,
      sessionKeyAddr: tuple.sessionKeyAddr,
      guardianAddr: guardianAddr!,
      accountSalt: tuple.accountSalt,
      accountAddr: addr!,
      initCodeHash: initCodeHash!,
      policy: {
        perTransferCap: tuple.policy.perTransferCap.toString(),
        windowCap: tuple.policy.windowCap.toString(),
        windowSeconds: tuple.policy.windowSeconds,
        expiresAt: tuple.policy.expiresAt,
      },
      allowlist: tuple.allowlist,
      timelockDelay: tuple.timelockDelay,
      txs,
    };
  } else {
    log({ check: 'reusing prior minted pair', result: `addr ${minted.accountAddr} salt ${minted.accountSalt.slice(0, 14)}…`, verdict: 'INFO' });
  }

  const create = {
    ownerAddr: minted.ownerAddr,
    sessionKeyAddr: minted.sessionKeyAddr,
    guardianAddr: minted.guardianAddr,
    policy: {
      perTransferCap: BigInt(minted.policy.perTransferCap),
      windowCap: BigInt(minted.policy.windowCap),
      windowSeconds: minted.policy.windowSeconds,
      expiresAt: minted.policy.expiresAt,
    },
    allowlist: minted.allowlist,
    timelockDelay: minted.timelockDelay,
  };
  const base = {
    ownerAddr: minted.ownerAddr,
    accountSalt: minted.accountSalt,
    create,
    chainIds: [HOME_ID, DEST_ID] as const,
    accountVersion: 6 as const,
    expectedAccountAddr: minted.accountAddr,
    initCodeHash: minted.initCodeHash,
    homeChainId: HOME_ID,
  };

  // ---- the PRODUCTION verifier, LIVE, honest tuple → must PASS ----
  try {
    const verified = await registry.assertSameAddress(base);
    const ok = verified.toLowerCase() === minted.accountAddr.toLowerCase();
    log({
      check: 'assertSameAddress v6 LIVE (5 singletons + predict + codehash + anchor + home-deployed)',
      result: `verified ${verified}`,
      verdict: ok ? 'PASS' : 'FAIL',
    });
  } catch (e) {
    log({ check: 'assertSameAddress v6 LIVE', result: (e as Error).message.slice(0, 140), verdict: 'FAIL' });
  }

  // ---- refusal arm (G-8 bar: 0 false same-address) ----
  await expectRefusal('tampered tuple (different sessionKey) is REFUSED', () =>
    registry.assertSameAddress({
      ...base,
      create: { ...create, sessionKeyAddr: privateKeyToAccount(generatePrivateKey()).address },
    }),
  );
  await expectRefusal('tampered persisted initCodeHash is REFUSED', () =>
    registry.assertSameAddress({ ...base, initCodeHash: `0x${'ab'.repeat(32)}` }),
  );
  await expectRefusal('counterfactual expectedAccountAddr is REFUSED', () =>
    registry.assertSameAddress({ ...base, expectedAccountAddr: '0x00000000000000000000000000000000000000aa' }),
  );
  await expectRefusal('undeployed home (fresh salt, no account) is REFUSED', () =>
    registry.assertSameAddress({
      ownerAddr: base.ownerAddr,
      accountSalt: `0x${'77'.repeat(32)}`,
      create,
      chainIds: base.chainIds,
      accountVersion: 6,
      homeChainId: HOME_ID,
    }),
  );

  const stamp = new Date().toISOString();
  const fails = rows.filter((r) => r.verdict === 'FAIL').length;
  writeFileSync(STATE, JSON.stringify({ stamp, home: HOME_ID, dest: DEST_ID, minted, rows }, null, 2));
  const md = [
    `# AQ-FND G-8 ACCOUNT-LEVEL same-address — ${stamp}`,
    '',
    `home 0G Galileo (${HOME_ID}) ⇄ dest Base Sepolia (${DEST_ID}) · account ${minted.accountAddr}`,
    '',
    '| check | result | verdict |',
    '|---|---|---|',
    ...rows.map((r) => `| ${r.check} | ${r.result.replace(/\|/g, '·')} | **${r.verdict}** |`),
  ].join('\n');
  writeFileSync(`${OUT}/g8-account-results.md`, md);
  console.log(`\n${rows.filter((r) => r.verdict === 'PASS').length} PASS · ${fails} FAIL · written → ${OUT}/g8-account-results.{json,md}`);
  process.exit(fails > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
