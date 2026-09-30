import { describe, it, expect } from 'vitest';
import type { PublicClient, WalletClient, Hex } from 'viem';
import {
  ChainRegistry,
  SameAddressMismatchError,
  UnregisteredChainError,
  type ChainConfig,
  type ChainTestClients,
} from '../../src/chain/registry.js';

/**
 * SE-6 (E-6) — ChainRegistry.assertSameAddress: the SAME (owner, salt) + the
 * SAME construction tuple must land the account at the SAME address on every
 * chain, and ANY divergence (factory address, factory bytecode, predicted
 * address, deployed-account bytecode) is DETECTED and REFUSED before funds are
 * routed cross-chain (spec §8 CREATE2 address-spoof). Fakes model two chains'
 * eth_call/getCode surfaces; no RPC is dialed.
 */

const FACTORY = ('0x' + '0f'.repeat(20)) as Hex;
const PREDICTED = ('0x' + 'ac'.repeat(20)) as Hex;
const OWNER = '0x' + 'ab'.repeat(20);
const SESSION = '0x' + 'cd'.repeat(20);
const SALT = '0x' + '5a'.repeat(32);
// Distinct bytecode blobs (codehash = keccak of these in ops.getCodeHash).
const FACTORY_CODE = ('0x60016000f3' + 'aa'.repeat(8)) as Hex;
const ACCOUNT_CODE = ('0x60016000f3' + 'bb'.repeat(8)) as Hex;

interface ChainFakeSpec {
  predicted?: Hex;
  factoryCode?: Hex | null;
  accountCode?: Hex | null;
  /** The configured contract is not a deterministic factory — predict reverts. */
  predictThrows?: Error;
  /** Captures the guardian arg each predict eth_call received (M-01 assertions). */
  capturedGuardians?: string[];
}

function fakeChainClients(spec: ChainFakeSpec = {}): ChainTestClients {
  const predicted = spec.predicted ?? PREDICTED;
  const factoryCode = spec.factoryCode === undefined ? FACTORY_CODE : spec.factoryCode;
  const accountCode = spec.accountCode === undefined ? null : spec.accountCode;
  const publicClient = {
    async readContract({ functionName, args }: { functionName: string; args: readonly unknown[] }) {
      if (spec.predictThrows) throw spec.predictThrows;
      if (functionName === 'predictAccountV4') {
        spec.capturedGuardians?.push(String(args[1]));
        return predicted;
      }
      throw new Error(`unexpected readContract ${functionName}`);
    },
    async getCode({ address }: { address: Hex }) {
      if (address.toLowerCase() === FACTORY.toLowerCase()) return factoryCode ?? undefined;
      if (address.toLowerCase() === predicted.toLowerCase()) return accountCode ?? undefined;
      return undefined;
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
    factoryAddr: '0x' + '01'.repeat(20),
    factoryV4Addr: FACTORY,
    registryAddr: '0x' + '02'.repeat(20),
    accountVersion: 4,
    gasFloorWei: 0n,
    ...overrides,
  };
}

function registry(
  specs: Record<number, ChainFakeSpec>,
  configOverrides: Record<number, Partial<ChainConfig>> = {},
): ChainRegistry {
  const ids = Object.keys(specs).map(Number);
  return new ChainRegistry(
    ids.map((id) => cfg(id, configOverrides[id] ?? {})),
    { opsPrivateKey: '0x' + '11'.repeat(32), guardianPrivateKey: '0x' + '22'.repeat(32) },
    new Map(ids.map((id) => [id, fakeChainClients(specs[id])])),
  );
}

const GUARDIAN = '0x' + 'ee'.repeat(20);
const input = {
  ownerAddr: OWNER,
  accountSalt: SALT,
  create: {
    ownerAddr: OWNER,
    sessionKeyAddr: SESSION,
    // M-01: the CREATE-TIME guardian (persisted), never the lane's live key.
    guardianAddr: GUARDIAN,
    policy: { perTransferCap: 1n, windowCap: 2n, windowSeconds: 3600, expiresAt: 0 },
    allowlist: [] as string[],
    timelockDelay: 900,
  },
  chainIds: [16602, 84532],
};

describe('SE-6 ChainRegistry.assertSameAddress (E-6)', () => {
  it('same factory + same bytecode + same prediction across chains → returns the verified address', async () => {
    const r = registry({ 16602: {}, 84532: {} });
    await expect(r.assertSameAddress(input)).resolves.toBe(PREDICTED.toLowerCase());
  });

  it('both accounts deployed with IDENTICAL bytecode still verifies', async () => {
    const r = registry({ 16602: { accountCode: ACCOUNT_CODE }, 84532: { accountCode: ACCOUNT_CODE } });
    await expect(r.assertSameAddress(input)).resolves.toBe(PREDICTED.toLowerCase());
  });

  it('REFUSES a divergent CREATE2 prediction (tuple/salt divergence)', async () => {
    const r = registry({ 16602: {}, 84532: { predicted: ('0x' + '99'.repeat(20)) as Hex } });
    await expect(r.assertSameAddress(input)).rejects.toThrow(SameAddressMismatchError);
    await expect(r.assertSameAddress(input)).rejects.toThrow(/predicted_address/);
  });

  it('REFUSES a factory-address divergence (different factory can never same-address)', async () => {
    const other = ('0x' + '77'.repeat(20)) as Hex;
    const r = registry(
      { 16602: {}, 84532: {} },
      { 84532: { factoryV4Addr: other } },
    );
    await expect(r.assertSameAddress(input)).rejects.toThrow(/factory_addr|factory_codehash/);
  });

  it('REFUSES a factory-bytecode divergence (spoofed factory at the right address)', async () => {
    const r = registry({ 16602: {}, 84532: { factoryCode: ('0xdeadbeef' + 'cc'.repeat(8)) as Hex } });
    await expect(r.assertSameAddress(input)).rejects.toThrow(/factory_codehash/);
  });

  it('REFUSES a missing factory (chain not V4-configured) and a code-less factory', async () => {
    const rMissing = registry({ 16602: {}, 84532: {} }, { 84532: { factoryV4Addr: undefined } });
    await expect(rMissing.assertSameAddress(input)).rejects.toThrow(/factory_missing/);
    const rNoCode = registry({ 16602: { factoryCode: null }, 84532: {} });
    await expect(rNoCode.assertSameAddress(input)).rejects.toThrow(/factory_codehash/);
  });

  it('REFUSES a deployed account whose bytecode diverges (wrong-bytecode spoof at the same address)', async () => {
    const r = registry({
      16602: { accountCode: ACCOUNT_CODE },
      84532: { accountCode: ('0xdeadbeef' + 'dd'.repeat(8)) as Hex },
    });
    await expect(r.assertSameAddress(input)).rejects.toThrow(/account_codehash/);
  });

  it('REFUSES (typed, not a raw RPC throw) when the configured contract is not a deterministic factory', async () => {
    // Both chains point at a contract with IDENTICAL bytecode that REVERTS on
    // predictAccountV4 (a non-factory) — factory addr + codehash checks pass,
    // the predict wrap must still produce a SameAddressMismatchError.
    const reverting: ChainFakeSpec = { predictThrows: new Error('The contract function "predictAccountV4" reverted.') };
    const r = registry({ 16602: reverting, 84532: reverting });
    await expect(r.assertSameAddress(input)).rejects.toThrow(SameAddressMismatchError);
    await expect(r.assertSameAddress(input)).rejects.toThrow(/predict reverted/);
  });

  it('M-01: predictions use the CREATE-TIME guardian from the input, never the lane key', async () => {
    const capturedGuardians: string[] = [];
    const r = registry({ 16602: { capturedGuardians }, 84532: { capturedGuardians } });
    await r.assertSameAddress(input);
    expect(capturedGuardians.map((g) => g.toLowerCase())).toEqual([GUARDIAN, GUARDIAN]);
  });

  it('M-01: REFUSES when the verified prediction is not the PERSISTED account address', async () => {
    // Consistent tuple drift: every chain predicts the same (wrong) address —
    // predictions agree with each other but not with agents.account_addr.
    const r = registry({ 16602: {}, 84532: {} });
    const persisted = '0x' + 'bd'.repeat(20);
    await expect(r.assertSameAddress({ ...input, expectedAccountAddr: persisted })).rejects.toThrow(/expected_account/);
    // Matching persisted address verifies.
    await expect(
      r.assertSameAddress({ ...input, expectedAccountAddr: PREDICTED }),
    ).resolves.toBe(PREDICTED.toLowerCase());
  });

  it('M-01/L-02: REFUSES "verified but deployed nowhere" when a home chain is named', async () => {
    const rUndeployed = registry({ 16602: {}, 84532: {} });
    await expect(rUndeployed.assertSameAddress({ ...input, homeChainId: 16602 })).rejects.toThrow(/home_chain_undeployed/);
    const rDeployed = registry({ 16602: { accountCode: ACCOUNT_CODE }, 84532: {} });
    await expect(rDeployed.assertSameAddress({ ...input, homeChainId: 16602 })).resolves.toBe(PREDICTED.toLowerCase());
    // a home chain that is not among the verified chainIds is a refusal too
    await expect(rDeployed.assertSameAddress({ ...input, homeChainId: 421614 })).rejects.toThrow(SameAddressMismatchError);
  });

  it('default-denies an unregistered chain (E-11) and requires ≥2 chains', async () => {
    const r = registry({ 16602: {}, 84532: {} });
    await expect(r.assertSameAddress({ ...input, chainIds: [16602, 421614] })).rejects.toThrow(UnregisteredChainError);
    await expect(r.assertSameAddress({ ...input, chainIds: [16602] })).rejects.toThrow(/at least 2 chains/);
  });
});
