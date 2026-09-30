import { describe, it, expect } from 'vitest';
import { buildChainConfigs, loadConfig, type Config } from '../../src/config.js';
import { LeashChainOps } from '../../src/chain/ops.js';
import type { PublicClient, WalletClient } from 'viem';

/**
 * SE-7 (E-7) — Base Sepolia onboarding is CONFIG-ONLY (the SE-5 promise): the
 * chain table gains the 84532 entry when BOTH env vars are set, and stays
 * default-deny (absent) otherwise. There is NO legacy v2 factory on Base — a
 * legacy create on a chain without one fails loudly, never silently minting
 * through the wrong factory.
 */

const BASE_ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgres://x',
  ZERO_G_COMPUTE_API_KEY: 'k',
  ZERO_G_RPC: 'http://rpc.leash-test.local',
  ZERO_G_CHAIN_ID: '16602',
  ZERO_G_STORAGE_INDEXER: 'http://indexer.leash-test.local',
  OPS_PRIVATE_KEY: '0x' + '11'.repeat(32),
  OPS_ADDRESS: '0x' + 'aa'.repeat(20),
  GUARDIAN_PRIVATE_KEY: '0x' + '22'.repeat(32),
  GUARDIAN_ADDRESS: '0x' + 'bb'.repeat(20),
  PRIVY_APP_ID: 'p',
  PRIVY_APP_SECRET: 's',
  KEY_ENCRYPTION_SECRET: 'ab'.repeat(32),
  AGENT_REGISTRY_ADDR: '0x' + 'cc'.repeat(20),
  LEASH_FACTORY_ADDR: '0x' + 'dd'.repeat(20),
  LEASH_FACTORY_V4_ADDR: '0x' + '44'.repeat(20),
};

function cfgWith(extra: NodeJS.ProcessEnv): Config {
  return loadConfig({ ...BASE_ENV, ...extra });
}

describe('SE-7 Base Sepolia chain config (config-only onboarding)', () => {
  it('appends the 84532 entry when BOTH BASE_SEPOLIA_RPC + AGENT_REGISTRY_BASE_ADDR are set', () => {
    const chains = buildChainConfigs(
      cfgWith({
        BASE_SEPOLIA_RPC: 'http://base.leash-test.local',
        AGENT_REGISTRY_BASE_ADDR: '0x' + 'ee'.repeat(20),
        BASE_CAP_ROUTER_ADDR: '0x' + '12'.repeat(20),
        BASE_CAP_VAULT_ADDR: '0x' + '13'.repeat(20),
        BASE_CAP_SETTLEMENT_TOKEN_ADDR: '0x' + '14'.repeat(20),
        BASE_PROTOCOL_ALLOWLIST: '0x' + '12'.repeat(20) + ', 0x' + '15'.repeat(20),
      }),
    );
    const base = chains.find((c) => c.chainId === 84532);
    expect(base).toBeDefined();
    expect(base?.name).toBe('Base Sepolia');
    // The V4 factory is the SAME deterministic CREATE2 address on every chain (SD-E9).
    expect(base?.factoryV4Addr).toBe('0x' + '44'.repeat(20));
    // V4-only chain: no legacy factory.
    expect(base?.factoryAddr).toBeUndefined();
    expect(base?.registryAddr).toBe('0x' + 'ee'.repeat(20));
    expect(base?.canonical?.router).toBe('0x' + '12'.repeat(20));
    expect(base?.canonical?.vault).toBe('0x' + '13'.repeat(20));
    expect(base?.canonical?.settlementToken).toBe('0x' + '14'.repeat(20));
    expect(base?.protocolAllowlist).toEqual(['0x' + '12'.repeat(20), '0x' + '15'.repeat(20)]);
    // The 0G home entry is untouched.
    expect(chains.find((c) => c.chainId === 16602)).toBeDefined();
  });

  it('default-deny: the Base entry is ABSENT unless both env vars are set', () => {
    for (const extra of [
      {},
      { BASE_SEPOLIA_RPC: 'http://base.leash-test.local' },
      { AGENT_REGISTRY_BASE_ADDR: '0x' + 'ee'.repeat(20) },
    ]) {
      const chains = buildChainConfigs(cfgWith(extra));
      expect(chains.find((c) => c.chainId === 84532)).toBeUndefined();
      expect(chains).toHaveLength(1);
    }
  });

  it('a malformed allowlist entry FAILS startup (sec L-03: never silently dropped)', () => {
    expect(() =>
      buildChainConfigs(
        cfgWith({
          BASE_SEPOLIA_RPC: 'http://base.leash-test.local',
          AGENT_REGISTRY_BASE_ADDR: '0x' + 'ee'.repeat(20),
          BASE_PROTOCOL_ALLOWLIST: 'not-an-address,0x' + '15'.repeat(20),
        }),
      ),
    ).toThrow(/not an address/);
  });

  it('a legacy (v2) create on a chain WITHOUT a legacy factory throws loudly', async () => {
    const ops = new LeashChainOps({
      rpcUrl: 'http://base.leash-test.local',
      chainId: 84532,
      opsPrivateKey: '0x' + '11'.repeat(32),
      guardianPrivateKey: '0x' + '22'.repeat(32),
      factoryV4Addr: '0x' + '44'.repeat(20),
      registryAddr: '0x' + 'ee'.repeat(20),
      clients: {
        publicClient: {} as unknown as PublicClient,
        opsWallet: { chain: undefined } as unknown as WalletClient,
        guardianWallet: { chain: undefined } as unknown as WalletClient,
      },
    });
    await expect(
      ops.deployAndRegister({
        accountVersion: 2,
        ownerAddr: '0x' + 'aa'.repeat(20),
        sessionKeyAddr: '0x' + 'ab'.repeat(20),
        policy: { perTransferCap: 1n, windowCap: 1n, windowSeconds: 60, expiresAt: 2_000_000_000 },
        allowlist: [],
        timelockDelay: 0,
        auditPubKey: 'de'.repeat(32),
        name: 'x',
      }),
    ).rejects.toThrow(/no legacy factory/);
  });
});
