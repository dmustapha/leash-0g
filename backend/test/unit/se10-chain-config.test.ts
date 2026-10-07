import { describe, it, expect } from 'vitest';
import { buildChainConfigs, loadConfig, parseExtraChains, type Config } from '../../src/config.js';
import { ChainRegistry, UnregisteredChainError, type ChainConfig } from '../../src/chain/registry.js';

/**
 * SE-10 (E-11) — close out Stage E's chain fan-out. Two theses proven here:
 *   1. PROMOTION: Ethereum Sepolia (11155111) goes from a bridge-DESTINATION-only
 *      chain (SE-8) to a FULL governed home chain purely by adding its real-protocol
 *      targets — config, not code.
 *   2. THIN REPEAT: any remaining top EVM testnet onboards through the GENERIC
 *      `EXTRA_CHAINS` table with NO per-chain code block — the end-to-end proof of
 *      SE-5's "adding a chain is config-only" promise. Any chain NOT in the table is
 *      DEFAULT-DENY (E-11): resolving it throws.
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
const V4 = '0x' + '44'.repeat(20);
function cfgWith(extra: NodeJS.ProcessEnv): Config {
  return loadConfig({ ...BASE_ENV, ...extra });
}
const SIGNING = { opsPrivateKey: '0x' + '11'.repeat(32), guardianPrivateKey: '0x' + '22'.repeat(32) };

describe('SE-10 — Ethereum Sepolia PROMOTION (destination-only → full governed home chain)', () => {
  const SEPOLIA_BASE = {
    ETHEREUM_SEPOLIA_RPC: 'http://sepolia.leash-test.local',
    AGENT_REGISTRY_SEPOLIA_ADDR: '0x' + 'ee'.repeat(20),
  };

  it('stays DESTINATION-ONLY (no canonical / no protocolAllowlist) before promotion', () => {
    const sep = buildChainConfigs(cfgWith(SEPOLIA_BASE)).find((c) => c.chainId === 11155111);
    expect(sep).toBeDefined();
    expect(sep?.canonical).toBeUndefined();
    expect(sep?.protocolAllowlist).toBeUndefined();
    expect(sep?.factoryV4Addr).toBe(V4); // same deterministic factory everywhere
  });

  it('PROMOTES to a full governed chain when real-protocol targets are configured', () => {
    const sep = buildChainConfigs(
      cfgWith({
        ...SEPOLIA_BASE,
        SEPOLIA_CAP_ROUTER_ADDR: '0x' + '12'.repeat(20),
        SEPOLIA_CAP_SETTLEMENT_TOKEN_ADDR: '0x' + '14'.repeat(20),
        SEPOLIA_PROTOCOL_ALLOWLIST: '0x' + '12'.repeat(20) + ', 0x' + '14'.repeat(20),
      }),
    ).find((c) => c.chainId === 11155111);
    expect(sep?.canonical?.router).toBe('0x' + '12'.repeat(20));
    expect(sep?.canonical?.settlementToken).toBe('0x' + '14'.repeat(20));
    expect(sep?.protocolAllowlist).toEqual(['0x' + '12'.repeat(20), '0x' + '14'.repeat(20)]);
    expect(sep?.accountVersion).toBe(4);
  });

  it('a malformed SEPOLIA_PROTOCOL_ALLOWLIST FAILS startup (L-03)', () => {
    expect(() =>
      buildChainConfigs(cfgWith({ ...SEPOLIA_BASE, SEPOLIA_PROTOCOL_ALLOWLIST: 'nope,0x' + '14'.repeat(20) })),
    ).toThrow(/not an address/);
  });
});

describe('SE-10 — the GENERIC chain-table (a new chain is CONFIG, not code)', () => {
  const OP = {
    chainId: 11155420,
    name: 'Optimism Sepolia',
    rpcUrl: 'http://op.leash-test.local',
    registryAddr: '0x' + 'ab'.repeat(20),
    protocolAllowlist: ['0x' + '12'.repeat(20)],
    canonical: { settlementToken: '0x' + '14'.repeat(20) },
  };
  const AMOY = {
    chainId: 80002,
    name: 'Polygon Amoy',
    rpcUrl: 'http://amoy.leash-test.local',
    registryAddr: '0x' + 'cd'.repeat(20),
  };

  it('onboards remaining testnets with ZERO new code — defaults factory to the deterministic CREATE2 addr', () => {
    const chains = buildChainConfigs(cfgWith({ EXTRA_CHAINS: JSON.stringify([OP, AMOY]) }));
    const op = chains.find((c) => c.chainId === 11155420);
    const amoy = chains.find((c) => c.chainId === 80002);
    expect(op?.name).toBe('Optimism Sepolia');
    expect(op?.factoryV4Addr).toBe(V4); // inherited LEASH_FACTORY_V4_ADDR
    expect(op?.accountVersion).toBe(4);
    expect(op?.protocolAllowlist).toEqual(['0x' + '12'.repeat(20)]);
    expect(op?.canonical?.settlementToken).toBe('0x' + '14'.repeat(20));
    expect(amoy?.name).toBe('Polygon Amoy');
    expect(amoy?.gasFloorWei).toBe(0n);
  });

  // F-2: dust is chain-priced — RH gas ≈ 0.012 gwei vs 0G's 2-gwei floor.
  it('a per-entry sessionGasDustWei parses to bigint; unset stays undefined (global default applies)', () => {
    const [op, amoy] = parseExtraChains(
      JSON.stringify([{ ...OP, sessionGasDustWei: '20000000000000' }, AMOY]),
      V4,
    );
    expect(op?.sessionGasDustWei).toBe(20_000_000_000_000n);
    expect(amoy?.sessionGasDustWei).toBeUndefined();
  });

  it('a malformed sessionGasDustWei fails startup (L-03 fail-loud)', () => {
    expect(() => parseExtraChains(JSON.stringify([{ ...OP, sessionGasDustWei: '0.002e18' }]), V4)).toThrow(
      /EXTRA_CHAINS\[0\] invalid/,
    );
  });

  it('a per-entry factoryV4Addr overrides the default deterministic factory', () => {
    const [op] = parseExtraChains(JSON.stringify([{ ...OP, factoryV4Addr: '0x' + '99'.repeat(20) }]), V4);
    expect(op?.factoryV4Addr).toBe('0x' + '99'.repeat(20)); // entry wins over defaultFactoryV4
  });

  it('a per-entry bridgeAllowlist uses the same addr:destChainId grammar', () => {
    const [op] = parseExtraChains(
      JSON.stringify([{ ...OP, bridgeAllowlist: '0x' + '42'.repeat(20) + ':11155111' }]),
      V4,
    );
    expect(op?.bridgeAllowlist).toEqual(['0x' + '42'.repeat(20)]);
    expect(op?.bridgeDestinations).toEqual({ ['0x' + '42'.repeat(20)]: 11155111 });
  });

  it('FAILS LOUD on malformed JSON, a missing required field, and a missing factory', () => {
    expect(() => parseExtraChains('{not json', V4)).toThrow(/not valid JSON/);
    expect(() => parseExtraChains(JSON.stringify({ chainId: 1 }), V4)).toThrow(/must be a JSON array/);
    expect(() => parseExtraChains(JSON.stringify([{ name: 'x', rpcUrl: 'http://x.local', registryAddr: '0x' + 'ab'.repeat(20) }]), V4)).toThrow(/invalid/);
    expect(() => parseExtraChains(JSON.stringify([OP]), undefined)).toThrow(/no factoryV4Addr/);
  });

  it('registers end-to-end: an EXTRA_CHAINS entry resolves through the ChainRegistry', () => {
    const chains = buildChainConfigs(cfgWith({ EXTRA_CHAINS: JSON.stringify([OP]) }));
    const reg = new ChainRegistry(chains, SIGNING);
    expect(reg.has(11155420)).toBe(true);
    expect(reg.getChainConfig(11155420).name).toBe('Optimism Sepolia');
  });
});

describe('SE-10 — DEFAULT-DENY (E-11): a chain NOT in the registry cannot be targeted', () => {
  it('resolving an unregistered chain throws UnregisteredChainError', () => {
    const reg = new ChainRegistry(buildChainConfigs(cfgWith({})), SIGNING);
    expect(reg.has(11155420)).toBe(false);
    expect(() => reg.getChainConfig(11155420)).toThrow(UnregisteredChainError);
    expect(() => reg.getChainOps(11155420)).toThrow(UnregisteredChainError);
    expect(() => reg.getSessionChain(11155420)).toThrow(UnregisteredChainError);
  });

  it('a mainnet chain id in EXTRA_CHAINS is REFUSED at registry construction (testnet-only, spec §4)', () => {
    const mainnet: ChainConfig[] = buildChainConfigs(
      cfgWith({ EXTRA_CHAINS: JSON.stringify([{ chainId: 10, name: 'OP Mainnet', rpcUrl: 'http://x.local', registryAddr: '0x' + 'ab'.repeat(20) }]) }),
    );
    expect(() => new ChainRegistry(mainnet, SIGNING)).toThrow(/mainnet/);
  });
});
