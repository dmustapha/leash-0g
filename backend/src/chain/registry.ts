import type { PublicClient, WalletClient } from 'viem';
import { LeashChainOps } from './ops.js';
import { SessionChain, type RuntimeChain } from '../runtime/session-chain.js';
import type { ChainOps } from '../server.js';

/**
 * SE-5 (Stage E, E-5) — the multichain backbone. One `ChainConfig` per deployed
 * testnet; the `ChainRegistry` resolves the correct on-chain client / factory /
 * canonical addresses / gas floor by `chainId`. This generalizes the single
 * `ZERO_G_RPC` + `LEASH_FACTORY_V4_ADDR` that SE-1 wired: adding a chain is a
 * config-only change (a new entry), never a code fork (proven by the table-driven
 * registry test). An unregistered chain is DEFAULT-DENY — every resolve throws
 * (E-11 chain-spoof guard), so no code path can silently act on a chain the owner
 * never configured.
 *
 * Scope note (SE-5): `protocolAllowlist` / `bridgeAllowlist` / `assertSameAddress`
 * are carried on the type for forward-compatibility (SE-6 CREATE2, SE-7 real
 * protocols, SE-8 bridging) but are NOT consumed here — SE-5 builds only the
 * resolution backbone + `(chainId, account)` read-model keying.
 */
export interface ChainConfig {
  chainId: number;
  name: string;
  rpcUrl: string;
  /** V4 (governed-calldata) factory — selected for accountVersion=4 creates (SE-1). */
  factoryV4Addr?: string | undefined;
  /** Legacy v2 factory (kept so mixed-version setups still create legacy accounts). */
  factoryAddr: string;
  registryAddr: string;
  /** Default account version minted on this chain (SD-E7: 4 = governed calldata). */
  accountVersion: number;
  /** Canonical deployed targets on this chain (mock/real per stage). */
  canonical?: {
    router?: string | undefined;
    vault?: string | undefined;
    settlementToken?: string | undefined;
  };
  /** 0G enforces a 2-gwei floor; other chains have their own. Applied at send time. */
  gasFloorWei: bigint;
  /** SE-7 forward-compat: allowlisted real protocols (Uniswap/Aave/Permit2, …). */
  protocolAllowlist?: readonly string[] | undefined;
  /** SE-8 forward-compat: allowlisted bridge contracts. */
  bridgeAllowlist?: readonly string[] | undefined;
}

/** Signing material shared across chains (same owner/ops/guardian keys per EVM). */
export interface ChainSigning {
  opsPrivateKey: string;
  guardianPrivateKey: string;
}

/** Per-chain injected fakes for hermetic tests (no RPC dial). */
export interface ChainTestClients {
  publicClient: PublicClient;
  opsWallet: WalletClient;
  guardianWallet: WalletClient;
}

/** Default-deny: resolving an unconfigured chain is a hard error (E-11). */
export class UnregisteredChainError extends Error {
  constructor(public readonly chainId: number) {
    super(`chain ${chainId} is not registered — default-deny (add a ChainConfig to onboard it)`);
    this.name = 'UnregisteredChainError';
  }
}

/**
 * Testnet-only guard (spec §4): production mainnet chain ids are refused at load
 * so a misconfig can never point the fleet at real-money chains. The known EVM
 * mainnets are rejected; everything else (testnets, local) is allowed.
 */
const MAINNET_CHAIN_IDS = new Set<number>([1, 10, 56, 137, 8453, 42161, 43114, 250, 100]);

export function assertTestnetOnly(configs: readonly ChainConfig[]): void {
  for (const c of configs) {
    if (MAINNET_CHAIN_IDS.has(c.chainId)) {
      throw new Error(`chain ${c.chainId} (${c.name}) is a mainnet — LEASH is testnet-only (spec §4)`);
    }
  }
}

export class ChainRegistry {
  private readonly byId = new Map<number, ChainConfig>();
  private readonly opsCache = new Map<number, LeashChainOps>();
  private readonly sessionCache = new Map<number, RuntimeChain>();

  constructor(
    configs: readonly ChainConfig[],
    private readonly signing: ChainSigning,
    /** chainId → injected fakes; when present, that chain's clients are not dialed. */
    private readonly testClients: ReadonlyMap<number, ChainTestClients> = new Map(),
  ) {
    if (configs.length === 0) throw new Error('ChainRegistry requires at least one chain config');
    assertTestnetOnly(configs);
    for (const c of configs) {
      if (this.byId.has(c.chainId)) throw new Error(`duplicate ChainConfig for chain ${c.chainId}`);
      this.byId.set(c.chainId, c);
    }
  }

  /** Every registered chain (config-only onboarding surface). */
  listChains(): ChainConfig[] {
    return [...this.byId.values()];
  }

  has(chainId: number): boolean {
    return this.byId.has(chainId);
  }

  /** Resolve a chain's static config, or default-deny. */
  getChainConfig(chainId: number): ChainConfig {
    const c = this.byId.get(chainId);
    if (!c) throw new UnregisteredChainError(chainId);
    return c;
  }

  /** Resolve (and cache) the deploy/govern ops lane for a chain, or default-deny. */
  getChainOps(chainId: number): LeashChainOps {
    const cached = this.opsCache.get(chainId);
    if (cached) return cached;
    const c = this.getChainConfig(chainId);
    const clients = this.testClients.get(chainId);
    const ops = new LeashChainOps({
      rpcUrl: c.rpcUrl,
      chainId: c.chainId,
      opsPrivateKey: this.signing.opsPrivateKey,
      guardianPrivateKey: this.signing.guardianPrivateKey,
      factoryAddr: c.factoryAddr,
      ...(c.factoryV4Addr ? { factoryV4Addr: c.factoryV4Addr } : {}),
      registryAddr: c.registryAddr,
      ...(clients ? { clients } : {}),
    });
    this.opsCache.set(chainId, ops);
    return ops;
  }

  /** Resolve (and cache) the runtime session-key chain for a chain, or default-deny. */
  getSessionChain(chainId: number): RuntimeChain {
    const cached = this.sessionCache.get(chainId);
    if (cached) return cached;
    const c = this.getChainConfig(chainId);
    const sc = new SessionChain({ rpcUrl: c.rpcUrl, chainId: c.chainId });
    this.sessionCache.set(chainId, sc);
    return sc;
  }
}

// Re-export so callers can depend on the registry module for the ops contract.
export type { ChainOps };
