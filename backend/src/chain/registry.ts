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
 * Scope note: `protocolAllowlist` / `bridgeAllowlist` are carried on the type for
 * forward-compatibility (SE-7 real protocols, SE-8 bridging) but are NOT consumed
 * yet. SE-6 defined `assertSameAddress` — the cross-chain CREATE2 same-address
 * verification that must PASS before any funds are routed cross-chain (spec §8).
 */
export interface ChainConfig {
  chainId: number;
  name: string;
  rpcUrl: string;
  /** V4 (governed-calldata) factory — selected for accountVersion=4 creates (SE-1). */
  factoryV4Addr?: string | undefined;
  /**
   * Legacy v2 factory (kept so mixed-version setups still create legacy
   * accounts). SE-7: OPTIONAL — a second chain onboarded V4-only (Base) has no
   * legacy factory; a legacy create there fails loudly (default-deny), never
   * silently mints through the wrong factory.
   */
  factoryAddr?: string | undefined;
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

/**
 * SE-6 (E-6): a cross-chain same-address verification FAILED — funds must NOT be
 * routed cross-chain for this agent. Carries which chain diverged and on what
 * (factory address / factory bytecode / predicted address / deployed account
 * bytecode) so the refusal is legible + actionable.
 */
export class SameAddressMismatchError extends Error {
  constructor(
    public readonly chainId: number,
    public readonly field:
      | 'factory_addr'
      | 'factory_codehash'
      | 'predicted_address'
      | 'account_codehash'
      | 'factory_missing'
      | 'expected_account'
      | 'home_chain_undeployed',
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(
      `same-address verification REFUSED at chain ${chainId}: ${field} diverges (expected ${expected}, got ${actual}) — do not route funds cross-chain`,
    );
    this.name = 'SameAddressMismatchError';
  }
}

/**
 * The construction tuple assertSameAddress predicts with. Must be the EXACT
 * create-time tuple (persisted at mint, `agents.account_create_tuple`) — it is
 * baked into the CREATE2 initcode, so any reconstruction drift (time-derived
 * expiry, rotated guardian key, reordered allowlist) predicts a DIFFERENT
 * address and the verification correctly refuses.
 */
export interface SameAddressCreateInput {
  ownerAddr: string;
  sessionKeyAddr: string;
  /**
   * The CREATE-TIME guardian address (persisted `agents.guardian_addr`) —
   * NEVER the lane's live guardian key (security M-01): a rotated guardian key
   * would consistently shift every chain's prediction to an address where no
   * account exists, vacuously skipping the deployed-codehash check.
   */
  guardianAddr: string;
  policy: { perTransferCap: bigint; windowCap: bigint; windowSeconds: number; expiresAt: number };
  allowlist: string[];
  timelockDelay: number;
  settlementToken?: string;
  tokenPolicy?: { perTransferCapToken: bigint; windowCapToken: bigint };
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
      ...(c.factoryAddr ? { factoryAddr: c.factoryAddr } : {}),
      ...(c.factoryV4Addr ? { factoryV4Addr: c.factoryV4Addr } : {}),
      registryAddr: c.registryAddr,
      ...(clients ? { clients } : {}),
    });
    this.opsCache.set(chainId, ops);
    return ops;
  }

  /**
   * SE-6 (E-6): verify that the SAME (owner, salt) + the SAME construction tuple
   * lands the account at the SAME address on every requested chain — and REFUSE
   * (throw) on ANY divergence, BEFORE funds are ever routed cross-chain (spec §8
   * CREATE2 address-spoof). Checks, per chain (all against the FIRST chain as the
   * reference):
   *   1. a deterministic V4 factory is configured, at the SAME address —
   *      CREATE2 derivation includes the factory address, so a different factory
   *      can never produce the same account;
   *   2. the factory BYTECODE is identical (codehash) — a different-bytecode
   *      contract squatting the factory address is a spoof;
   *   3. the eth_called CREATE2 prediction is identical — catches ANY tuple/salt
   *      divergence (constructor args are part of the initcode);
   *   4. where the account is already deployed, its BYTECODE is identical across
   *      the deployed chains — a wrong-bytecode account at the right address is
   *      a spoof (funds would land outside the wall).
   * Returns the verified same-address. Unregistered chains default-deny (E-11).
   */
  async assertSameAddress(input: {
    ownerAddr: string;
    /** The per-agent CREATE2 salt (0x bytes32, from agents.account_salt). */
    accountSalt: string;
    create: SameAddressCreateInput;
    chainIds: readonly number[];
    /**
     * The persisted account address (`agents.account_addr`) the caller is about
     * to route funds for. When provided, the verification BINDS the prediction
     * to it — a reconstructed-tuple drift can never "verify" a counterfactual
     * address the agent row is not bound to (security M-01). Omit only at
     * pre-create time (no account exists yet).
     */
    expectedAccountAddr?: string;
    /**
     * The agent's home chain: when provided, the account must have DEPLOYED
     * bytecode there — "verified but deployed nowhere" is a refusal, not a
     * success (security M-01/L-02).
     */
    homeChainId?: number;
  }): Promise<string> {
    if (input.chainIds.length < 2) {
      throw new Error('assertSameAddress requires at least 2 chains (cross-chain verification)');
    }
    // PASS 1 — factory identity FIRST (address + bytecode), so a misconfigured /
    // spoofed factory is refused with a TYPED error BEFORE any eth_call is made
    // against it (a predict against a non-factory contract would surface as a raw
    // RPC revert instead of a legible refusal).
    const factories: Array<{ chainId: number; factoryAddr: string; factoryCodehash: string | null }> = [];
    for (const chainId of input.chainIds) {
      const cfg = this.getChainConfig(chainId); // default-deny (E-11)
      const ops = this.getChainOps(chainId);
      const factoryAddr = cfg.factoryV4Addr?.toLowerCase();
      if (!factoryAddr) {
        throw new SameAddressMismatchError(chainId, 'factory_missing', 'a configured V4 factory', 'none');
      }
      factories.push({ chainId, factoryAddr, factoryCodehash: await ops.getCodeHash(factoryAddr) });
    }
    const refFactory = factories[0];
    if (!refFactory) throw new Error('assertSameAddress: unreachable — no chains resolved');
    if (refFactory.factoryCodehash === null) {
      // No factory bytecode on the reference chain — nothing is verifiable.
      throw new SameAddressMismatchError(refFactory.chainId, 'factory_codehash', 'deployed factory bytecode', 'no code');
    }
    for (const f of factories.slice(1)) {
      if (f.factoryAddr !== refFactory.factoryAddr) {
        throw new SameAddressMismatchError(f.chainId, 'factory_addr', refFactory.factoryAddr, f.factoryAddr);
      }
      if (f.factoryCodehash !== refFactory.factoryCodehash) {
        throw new SameAddressMismatchError(f.chainId, 'factory_codehash', refFactory.factoryCodehash, f.factoryCodehash ?? 'no code');
      }
    }
    // PASS 2 — CREATE2 predictions + deployed-account bytecode.
    const perChain: Array<{ chainId: number; predicted: string; accountCodehash: string | null }> = [];
    for (const chainId of input.chainIds) {
      const ops = this.getChainOps(chainId);
      let predicted: string;
      try {
        predicted = (
          await ops.predictAccountV4({
            ownerAddr: input.ownerAddr,
            sessionKeyAddr: input.create.sessionKeyAddr,
            guardianAddr: input.create.guardianAddr,
            policy: input.create.policy,
            allowlist: input.create.allowlist,
            timelockDelay: input.create.timelockDelay,
            ...(input.create.settlementToken !== undefined ? { settlementToken: input.create.settlementToken } : {}),
            ...(input.create.tokenPolicy !== undefined ? { tokenPolicy: input.create.tokenPolicy } : {}),
            accountSalt: input.accountSalt,
          })
        ).toLowerCase();
      } catch (err) {
        // A reverting predict means the configured contract is NOT a deterministic
        // V4 factory (even though its bytecode matched across chains) — a spoof or
        // a misconfig either way: refuse with the typed error, never a raw throw.
        throw new SameAddressMismatchError(
          chainId,
          'predicted_address',
          'a CREATE2 prediction',
          `predict reverted (${err instanceof Error ? err.message.slice(0, 80) : String(err).slice(0, 80)})`,
        );
      }
      perChain.push({ chainId, predicted, accountCodehash: await ops.getCodeHash(predicted) });
    }
    const ref = perChain[0];
    if (!ref) throw new Error('assertSameAddress: unreachable — no chains resolved');
    for (const c of perChain.slice(1)) {
      if (c.predicted !== ref.predicted) {
        throw new SameAddressMismatchError(c.chainId, 'predicted_address', ref.predicted, c.predicted);
      }
    }
    // Bind the prediction to the PERSISTED account (security M-01): consistent
    // tuple-reconstruction drift shifts every chain's prediction in lockstep —
    // predictions agree with each other but not with the account the agent row
    // (and any funds routing) is actually bound to. Refuse, never "verify" a
    // counterfactual address.
    if (input.expectedAccountAddr !== undefined && ref.predicted !== input.expectedAccountAddr.toLowerCase()) {
      throw new SameAddressMismatchError(ref.chainId, 'expected_account', input.expectedAccountAddr.toLowerCase(), ref.predicted);
    }
    // "Verified but deployed nowhere" is a refusal (M-01/L-02): the agent's home
    // chain must host the account's bytecode before anything routes cross-chain.
    if (input.homeChainId !== undefined) {
      const home = perChain.find((c) => c.chainId === input.homeChainId);
      if (!home) {
        throw new SameAddressMismatchError(input.homeChainId, 'home_chain_undeployed', 'home chain among the verified chainIds', 'absent');
      }
      if (home.accountCodehash === null) {
        throw new SameAddressMismatchError(input.homeChainId, 'home_chain_undeployed', 'deployed account bytecode on the home chain', 'no code');
      }
    }
    // Account-bytecode identity across the chains where it IS deployed. (A chain
    // where it is not yet deployed is fine — that is the pre-onboarding state.)
    const deployed = perChain.filter((c) => c.accountCodehash !== null);
    const refDeployed = deployed[0];
    if (refDeployed) {
      for (const c of deployed.slice(1)) {
        if (c.accountCodehash !== refDeployed.accountCodehash) {
          throw new SameAddressMismatchError(
            c.chainId,
            'account_codehash',
            refDeployed.accountCodehash as string,
            c.accountCodehash as string,
          );
        }
      }
    }
    return ref.predicted;
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
