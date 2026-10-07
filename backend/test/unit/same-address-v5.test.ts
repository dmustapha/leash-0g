import { describe, it, expect } from 'vitest';
import type { PublicClient, WalletClient, Hex } from 'viem';
import {
  ChainRegistry,
  SameAddressMismatchError,
  type ChainConfig,
  type ChainTestClients,
} from '../../src/chain/registry.js';

/**
 * Stage F′ (FP-4 P1) — assertSameAddress for V5 (accountVersion:5). Unlike V4 (a
 * factory eth_call), V5 verifies the THREE pinned singletons (generic deployer +
 * both helpers, address + codehash) across chains, then predicts OFF-CHAIN. The
 * fake only serves getCode (codehash) for the three singletons + the predicted
 * account — no predict eth_call is made (predictAccountV5 is pure).
 */

const DEPLOYER = ('0x' + 'd1'.repeat(20)) as Hex;
const SIGNING = ('0x' + '51'.repeat(20)) as Hex;
const DECODE = ('0x' + 'de'.repeat(20)) as Hex;
const OWNER = '0x' + 'ab'.repeat(20);
const SESSION = '0x' + 'cd'.repeat(20);
const GUARDIAN = '0x' + 'ee'.repeat(20);
const SALT = '0x' + '5a'.repeat(32);

const DEPLOYER_CODE = ('0x60016000f3' + 'aa'.repeat(8)) as Hex;
const HELPER_CODE = ('0x60016000f3' + 'bb'.repeat(8)) as Hex;
const ACCOUNT_CODE = ('0x60016000f3' + 'cc'.repeat(8)) as Hex;

interface V5FakeSpec {
  deployerAddr?: Hex;
  signingAddr?: Hex;
  decodeAddr?: Hex;
  deployerCode?: Hex | null;
  signingCode?: Hex | null;
  decodeCode?: Hex | null;
  accountCode?: Hex | null;
}

function fakeClients(spec: V5FakeSpec, predictedAddr: () => string): ChainTestClients {
  const map = new Map<string, Hex | null>();
  map.set((spec.deployerAddr ?? DEPLOYER).toLowerCase(), spec.deployerCode === undefined ? DEPLOYER_CODE : spec.deployerCode);
  map.set((spec.signingAddr ?? SIGNING).toLowerCase(), spec.signingCode === undefined ? HELPER_CODE : spec.signingCode);
  map.set((spec.decodeAddr ?? DECODE).toLowerCase(), spec.decodeCode === undefined ? HELPER_CODE : spec.decodeCode);
  const publicClient = {
    async readContract({ functionName }: { functionName: string }) {
      throw new Error(`V5 same-address must not eth_call (got ${functionName})`);
    },
    async getCode({ address }: { address: Hex }) {
      const a = address.toLowerCase();
      if (a === predictedAddr().toLowerCase()) return spec.accountCode ?? undefined;
      return map.get(a) ?? undefined;
    },
  } as unknown as PublicClient;
  const wallet = { chain: undefined } as unknown as WalletClient;
  return { publicClient, opsWallet: wallet, guardianWallet: wallet };
}

function cfg(chainId: number, overrides: Partial<ChainConfig> = {}): ChainConfig {
  return {
    chainId,
    name: `chain-${chainId}`,
    rpcUrl: 'http://rpc.leash-test.local',
    create2DeployerAddr: DEPLOYER.toLowerCase(),
    signingHelperAddr: SIGNING.toLowerCase(),
    decodeHelperAddr: DECODE.toLowerCase(),
    registryAddr: '0x' + '02'.repeat(20),
    accountVersion: 4,
    gasFloorWei: 0n,
    ...overrides,
  };
}

function registry(
  specs: Record<number, V5FakeSpec>,
  configOverrides: Record<number, Partial<ChainConfig>> = {},
): ChainRegistry {
  const ids = Object.keys(specs).map(Number);
  // The predicted address is identical across chains when singletons match — a
  // thunk lets the fake resolve it lazily (it is pure f(deployer,salt,initcode)).
  let predicted = '0x0000000000000000000000000000000000000000';
  const reg = new ChainRegistry(
    ids.map((id) => cfg(id, configOverrides[id] ?? {})),
    { opsPrivateKey: '0x' + '11'.repeat(32), guardianPrivateKey: '0x' + '22'.repeat(32) },
    new Map(ids.map((id) => [id, fakeClients(specs[id] ?? {}, () => predicted)])),
  );
  predicted = reg.getChainOps(ids[0] as number).predictAccountV5({
    ownerAddr: OWNER,
    guardianAddr: GUARDIAN,
    sessionKeyAddr: SESSION,
    policy: { perTransferCap: 1n, windowCap: 2n, windowSeconds: 3600, expiresAt: 0 },
    allowlist: [],
    timelockDelay: 900,
    accountSalt: SALT,
  });
  return reg;
}

const input = {
  ownerAddr: OWNER,
  accountSalt: SALT,
  create: {
    ownerAddr: OWNER,
    sessionKeyAddr: SESSION,
    guardianAddr: GUARDIAN,
    policy: { perTransferCap: 1n, windowCap: 2n, windowSeconds: 3600, expiresAt: 0 },
    allowlist: [] as string[],
    timelockDelay: 900,
  },
  chainIds: [16602, 84532],
  accountVersion: 5 as const,
};

describe('FP-4 assertSameAddress (V5 — pinned singletons + off-chain predict)', () => {
  it('identical singletons + identical off-chain prediction → returns the verified address', async () => {
    const r = registry({ 16602: {}, 84532: {} });
    const addr = await r.assertSameAddress(input);
    expect(addr).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it('REFUSES a divergent DEPLOYER address across chains', async () => {
    const other = ('0x' + '99'.repeat(20)) as Hex;
    const r = registry({ 16602: {}, 84532: {} }, { 84532: { create2DeployerAddr: other.toLowerCase() } });
    await expect(r.assertSameAddress(input)).rejects.toThrow(/singleton_addr|singleton_codehash|predicted_address|singleton_missing/);
  });

  it('REFUSES a divergent helper codehash (spoofed helper at the right address)', async () => {
    const r = registry({ 16602: {}, 84532: { signingCode: ('0xdeadbeef' + 'cc'.repeat(8)) as Hex } });
    await expect(r.assertSameAddress(input)).rejects.toThrow(/singleton_codehash/);
  });

  it('REFUSES a MISSING pinned singleton on a chain (default-deny)', async () => {
    const r = registry({ 16602: {}, 84532: {} }, { 84532: { decodeHelperAddr: undefined } });
    await expect(r.assertSameAddress(input)).rejects.toThrow(SameAddressMismatchError);
    await expect(r.assertSameAddress(input)).rejects.toThrow(/singleton_missing/);
  });

  it('REFUSES a code-less deployer (no bytecode on the reference chain)', async () => {
    const r = registry({ 16602: { deployerCode: null }, 84532: {} });
    await expect(r.assertSameAddress(input)).rejects.toThrow(/singleton_codehash/);
  });

  it('REFUSES a deployed account whose bytecode diverges across chains', async () => {
    const r = registry({
      16602: { accountCode: ACCOUNT_CODE },
      84532: { accountCode: ('0xdeadbeef' + 'dd'.repeat(8)) as Hex },
    });
    await expect(r.assertSameAddress(input)).rejects.toThrow(/account_codehash/);
  });

  // RULING-A active anchor (Gate-② W-02): the persisted init_code_hash binds the tuple.
  it('ACCEPTS when the persisted initCodeHash matches the rebuilt tuple', async () => {
    const r = registry({ 16602: {}, 84532: {} });
    const hash = r.getChainOps(16602).v5InitCodeHash({
      ownerAddr: OWNER, guardianAddr: GUARDIAN, sessionKeyAddr: SESSION,
      policy: { perTransferCap: 1n, windowCap: 2n, windowSeconds: 3600, expiresAt: 0 },
      allowlist: [], timelockDelay: 900, accountSalt: SALT,
    });
    const addr = await r.assertSameAddress({ ...input, initCodeHash: hash });
    expect(addr).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it('REFUSES a persisted initCodeHash that does not match the rebuilt tuple (post-mint drift)', async () => {
    const r = registry({ 16602: {}, 84532: {} });
    const bogus = ('0x' + 'ab'.repeat(32)) as Hex;
    await expect(r.assertSameAddress({ ...input, initCodeHash: bogus })).rejects.toThrow(/init_code_hash/);
  });
});
