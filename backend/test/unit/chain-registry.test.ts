import { describe, it, expect } from 'vitest';
import type { PublicClient, WalletClient } from 'viem';
import {
  ChainRegistry,
  UnregisteredChainError,
  assertTestnetOnly,
  type ChainConfig,
  type ChainTestClients,
} from '../../src/chain/registry.js';

/**
 * SE-5 (E-5) — the ChainRegistry backbone. Adding a chain is CONFIG-ONLY (a new
 * ChainConfig entry), never a code fork: the same registry resolves N chains by
 * chainId. An unregistered chain is DEFAULT-DENY (every resolve throws), the
 * chain-spoof / unregistered-chain guard (E-11). Mainnets are refused at load
 * (testnet-only, spec §4). Table-driven: the assertions enumerate over the config
 * table itself, so a future chain onboarded by config is covered with no new test.
 */

const SIGNING = {
  opsPrivateKey: '0x' + '11'.repeat(32),
  guardianPrivateKey: '0x' + '22'.repeat(32),
};

function cfg(chainId: number, name: string): ChainConfig {
  return {
    chainId,
    name,
    rpcUrl: `http://rpc-${chainId}.leash-test.local`,
    factoryAddr: '0x' + '01'.repeat(20),
    factoryV4Addr: '0x' + '04'.repeat(20),
    registryAddr: '0x' + '02'.repeat(20),
    accountVersion: 4,
    gasFloorWei: 2_000_000_000n,
  };
}

// Two distinct testnet chains — a 0G-like id + a Base-Sepolia-like id (SE-7 shape).
const CHAIN_A = cfg(16602, '0G Galileo Testnet');
const CHAIN_B = cfg(84532, 'Base Sepolia');

function fakeClients(): ChainTestClients {
  return {
    publicClient: {} as unknown as PublicClient,
    opsWallet: { chain: undefined } as unknown as WalletClient,
    guardianWallet: { chain: undefined } as unknown as WalletClient,
  };
}

describe('SE-5 ChainRegistry (E-5)', () => {
  it('resolves ops + session clients for EACH registered chain (config-only, table-driven)', () => {
    const testClients = new Map([
      [CHAIN_A.chainId, fakeClients()],
      [CHAIN_B.chainId, fakeClients()],
    ]);
    const registry = new ChainRegistry([CHAIN_A, CHAIN_B], SIGNING, testClients);

    // Every entry in the config table resolves — no per-chain code path.
    for (const c of [CHAIN_A, CHAIN_B]) {
      expect(registry.has(c.chainId)).toBe(true);
      expect(registry.getChainConfig(c.chainId).name).toBe(c.name);
      expect(registry.getChainOps(c.chainId)).toBeDefined();
      expect(registry.getSessionChain(c.chainId)).toBeDefined();
    }
    expect(registry.listChains().map((c) => c.chainId).sort()).toEqual([16602, 84532]);
  });

  it('caches the resolved ops/session client per chain (same instance on re-resolve)', () => {
    const registry = new ChainRegistry([CHAIN_A], SIGNING, new Map([[CHAIN_A.chainId, fakeClients()]]));
    expect(registry.getChainOps(CHAIN_A.chainId)).toBe(registry.getChainOps(CHAIN_A.chainId));
    expect(registry.getSessionChain(CHAIN_A.chainId)).toBe(registry.getSessionChain(CHAIN_A.chainId));
  });

  it('DEFAULT-DENY: resolving an unregistered chain throws (E-11 chain-spoof guard)', () => {
    const registry = new ChainRegistry([CHAIN_A], SIGNING, new Map([[CHAIN_A.chainId, fakeClients()]]));
    expect(registry.has(999)).toBe(false);
    expect(() => registry.getChainConfig(999)).toThrow(UnregisteredChainError);
    expect(() => registry.getChainOps(999)).toThrow(UnregisteredChainError);
    expect(() => registry.getSessionChain(999)).toThrow(UnregisteredChainError);
  });

  it('refuses a duplicate chainId in the config table', () => {
    expect(() => new ChainRegistry([CHAIN_A, cfg(CHAIN_A.chainId, 'dup')], SIGNING)).toThrow(/duplicate/);
  });

  it('requires at least one chain', () => {
    expect(() => new ChainRegistry([], SIGNING)).toThrow(/at least one/);
  });

  it('testnet-only: a mainnet chainId is refused at load (spec §4)', () => {
    expect(() => assertTestnetOnly([cfg(1, 'Ethereum Mainnet')])).toThrow(/mainnet/);
    expect(() => assertTestnetOnly([cfg(8453, 'Base Mainnet')])).toThrow(/mainnet/);
    expect(() => new ChainRegistry([cfg(42161, 'Arbitrum One')], SIGNING)).toThrow(/mainnet/);
    // testnets pass
    expect(() => assertTestnetOnly([CHAIN_A, CHAIN_B])).not.toThrow();
  });
});
