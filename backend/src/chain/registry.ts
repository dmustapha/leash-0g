import type { PublicClient, WalletClient } from 'viem';
import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { LeashChainOps, zeroGChain } from './ops.js';
import { SessionChain, type RuntimeChain } from '../runtime/session-chain.js';
import type { ChainOps } from '../server.js';
import type { GasRouteSurface } from '../runtime/gas.js';

/**
 * AQ-FND M-3 rung-4: the chain primitives the runtime's EIP-7702 bootstrap executor
 * needs. `opsRelayerAddr` (the ops key's address) is the repay recipient (config,
 * never model-derived) and must be an allowlisted token payee for the agent's account.
 */
export interface BootstrapGasPrimitives {
  publicClient: PublicClient;
  opsWallet: WalletClient;
  opsRelayerAddr: string;
  delegate: string;
  buildSessionWallet: (sessionPrivateKey: string) => WalletClient;
}

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
 * SE-8: `bridgeAllowlist`/`bridgeDestinations` are CONSUMED (bridge lane classify
 * + the runtime's pre-routing gate) and `protocolAllowlist` gates the owner grant
 * surface — no dormant spend-gate-looking fields remain (SE-7 gate carry #2).
 * `assertSameAddress` (SE-6) is the cross-chain CREATE2 same-address verification
 * that must PASS before any funds are routed cross-chain (spec §8) — its first
 * production caller is the SE-8 bridge pre-routing gate (`runtime/bridge-gate.ts`).
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
  /**
   * Stage F′ (FP-4 P1): the generic CREATE2 deployer — the account-agnostic
   * dispatcher a V5 create mints THROUGH (the backend assembles initcode off-chain
   * and passes it in). Per-chain, operator-set, lowercase-normalized (like
   * factoryV4Addr). Must be the SAME address on every chain (deployed via the std
   * deterministic-deployment proxy with a fixed salt) for cross-chain same-address.
   */
  create2DeployerAddr?: string | undefined;
  /**
   * Stage F′ (FP-4 P1, RULING-B): the SigningLib helper singleton baked into the
   * V5 account initcode. The canonical address the post-deploy read-back asserts —
   * NEVER request input. Must be the SAME address on every chain (pinned singleton).
   */
  signingHelperAddr?: string | undefined;
  /**
   * Stage F′ (FP-4 P1, RULING-B): the DecodeLib helper singleton baked into the V5
   * account initcode. Canonical, read-back-asserted, same-address-pinned. A V5
   * create is DEFAULT-DENIED on a chain missing ANY of the three singletons.
   */
  decodeHelperAddr?: string | undefined;
  /** AQ-FND V6 singletons (PolicyLib / EnvelopeModule / GasRepayDelegate) — same-address-pinned;
   *  a V6 create or verify is DEFAULT-DENIED on a chain missing any required one. */
  policyHelperAddr?: string | undefined;
  envelopeModuleAddr?: string | undefined;
  gasRepayDelegateAddr?: string | undefined;
  /** Default account version minted on this chain (SD-E7: 4 = governed calldata). */
  accountVersion: number;
  /** Canonical deployed targets on this chain (mock/real per stage). */
  canonical?: {
    router?: string | undefined;
    vault?: string | undefined;
    settlementToken?: string | undefined;
  };
  /**
   * AQ-FND M-3 inc-3a: the swap-to-gas executor's per-chain constants (a chain whose
   * `canonical.router` is a Uniswap V3 SwapRouter02). OWNER/OPERATOR config - never
   * model-derived. Unset => the planner may still find `swap-to-gas` (router configured) but
   * nothing executes: the runtime raises the honest ask instead.
   */
  gasSwap?:
    | {
        /** the chain's WETH9 (swap output; `withdraw` unwraps it to native). Lowercased. */
        wrappedNative: string;
        /** the WETH/settlement-token pool fee tier (probe: Base 3000, Eth 10000, Arb 3000). */
        dexFeeTier: number;
        /** token base units sold per gas swap, e.g. 5 USDC = 5_000_000 (6 decimals). */
        tokenAmount: bigint;
      }
    | undefined;
  /** 0G enforces a 2-gwei floor; other chains have their own. Applied at send time. */
  gasFloorWei: bigint;
  /**
   * F-2: session-key gas dust is CHAIN-PRICED — RH (46630) gas is ~0.012 gwei,
   * so the 0G-sized global default (0.002) is orders of magnitude oversized
   * there and drains the ops wallet per create. Unset ⇒ the global
   * SESSION_GAS_DUST_WEI default applies.
   */
  sessionGasDustWei?: bigint | undefined;
  /**
   * Allowlisted real protocols (Uniswap/Aave/Permit2, …). SE-8 (carry #2): when
   * SET, the owner grant surface refuses call-rule/preset targets outside
   * `protocolAllowlist ∪ bridgeAllowlist ∪ canonical` — no longer dormant.
   */
  protocolAllowlist?: readonly string[] | undefined;
  /**
   * SE-8 (carry #2, CONSUMED): allowlisted bridge contracts on this chain. Fed
   * into `GrantState.bridgeTargets` — classify refuses a bridge selector against
   * any target outside this set, and any non-bridge selector against a target
   * inside it (BR-2 default-DENY).
   */
  bridgeAllowlist?: readonly string[] | undefined;
  /**
   * SE-8: lowercased bridge address → the chain id its far leg lands on. The
   * runtime's HARD pre-routing gate verifies the same-CREATE2-address account on
   * that destination chain (`assertSameAddress`) BEFORE any bridge call routes.
   */
  bridgeDestinations?: Readonly<Record<string, number>> | undefined;
  /**
   * RH2 (SE-9 two-factory): named, operator-configured SECONDARY factories that
   * carry a wall CAPABILITY distinct from the chain's default (same-address) wall.
   * Keyed by capability name (e.g. `oracleBand` → the audit-fixed price-band wall
   * factory). A create may target one BY NAME (`POST /api/agents {capability}`) —
   * the address is NEVER caller-supplied, so a caller can never inject an arbitrary
   * factory. Default-deny: a capability not listed here for this chain is refused.
   */
  capabilityFactories?: Readonly<Record<string, string>> | undefined;
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
      | 'home_chain_undeployed'
      // Stage F′ (FP-4 P1): the 3 pinned V5 singletons (deployer + both helpers) —
      // address divergence, bytecode divergence, or an absent singleton on a chain.
      | 'singleton_addr'
      | 'singleton_codehash'
      | 'singleton_missing'
      // Stage F′ (FP-4 P1, Gate-② W-02): the rebuilt V5 initcode hash diverges from the
      // PERSISTED agents.init_code_hash — the construction tuple drifted after mint (RULING-A anchor).
      | 'init_code_hash',
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
  /** RH2 (two-factory): capability-factory lanes, keyed `${chainId}:${factory}`. */
  private readonly opsForFactoryCache = new Map<string, LeashChainOps>();
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
      ...(c.create2DeployerAddr ? { create2DeployerAddr: c.create2DeployerAddr } : {}),
      ...(c.signingHelperAddr ? { signingHelperAddr: c.signingHelperAddr } : {}),
      ...(c.decodeHelperAddr ? { decodeHelperAddr: c.decodeHelperAddr } : {}),
      ...(c.policyHelperAddr ? { policyHelperAddr: c.policyHelperAddr } : {}),
      ...(c.envelopeModuleAddr ? { envelopeModuleAddr: c.envelopeModuleAddr } : {}),
      ...(c.gasRepayDelegateAddr ? { gasRepayDelegateAddr: c.gasRepayDelegateAddr } : {}),
      registryAddr: c.registryAddr,
      ...(clients ? { clients } : {}),
    });
    this.opsCache.set(chainId, ops);
    return ops;
  }

  /**
   * RH2 (two-factory): resolve the operator-configured factory for a NAMED wall
   * capability on this chain, or `undefined` if the chain declares none. The name
   * is an operator-controlled KEY — the resolved address never comes from the
   * caller — so this cannot be used to inject an arbitrary factory (the security
   * property that lets `POST /api/agents {capability}` be safe).
   */
  getCapabilityFactory(chainId: number, capability: string): string | undefined {
    return this.getChainConfig(chainId).capabilityFactories?.[capability];
  }

  /**
   * RH2 (two-factory): an ops lane whose V4 factory is `factoryV4Addr`, cached per
   * `${chainId}:${factory}`. Default-deny: the factory MUST be either the chain's
   * default V4 factory or one of its named `capabilityFactories` — an off-config
   * address is refused, so a create can only ever mint through an operator-vetted
   * factory. Everything else (RPC, keys, registry) matches the default lane.
   */
  getChainOpsForFactory(chainId: number, factoryV4Addr: string): LeashChainOps {
    const c = this.getChainConfig(chainId);
    const want = factoryV4Addr.toLowerCase();
    const allowed = new Set<string>([
      ...(c.factoryV4Addr ? [c.factoryV4Addr.toLowerCase()] : []),
      ...Object.values(c.capabilityFactories ?? {}).map((a) => a.toLowerCase()),
    ]);
    if (!allowed.has(want)) {
      throw new Error(`factory ${want} is not a configured factory for chain ${chainId} (default-deny)`);
    }
    // The default factory reuses the standard cached lane (byte-identical wire).
    if (c.factoryV4Addr && want === c.factoryV4Addr.toLowerCase()) return this.getChainOps(chainId);
    const key = `${chainId}:${want}`;
    const cached = this.opsForFactoryCache.get(key);
    if (cached) return cached;
    const clients = this.testClients.get(chainId);
    const ops = new LeashChainOps({
      rpcUrl: c.rpcUrl,
      chainId: c.chainId,
      opsPrivateKey: this.signing.opsPrivateKey,
      guardianPrivateKey: this.signing.guardianPrivateKey,
      ...(c.factoryAddr ? { factoryAddr: c.factoryAddr } : {}),
      factoryV4Addr: want,
      registryAddr: c.registryAddr,
      ...(clients ? { clients } : {}),
    });
    this.opsForFactoryCache.set(key, ops);
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
     * Stage F′ (FP-4 P1): which deterministic account the agent uses. 4 (default,
     * back-compat with every existing caller) verifies the V4 factory identity +
     * `predictAccountV4`; 5 verifies the 3 PINNED V5 singletons (generic deployer +
     * both helper contracts, address + codehash) across chains + the off-chain
     * `predictAccountV5`. A chain missing any pinned singleton is REFUSED.
     */
    accountVersion?: 4 | 5 | 6;
    /**
     * The persisted account address (`agents.account_addr`) the caller is about
     * to route funds for. When provided, the verification BINDS the prediction
     * to it — a reconstructed-tuple drift can never "verify" a counterfactual
     * address the agent row is not bound to (security M-01). Omit only at
     * pre-create time (no account exists yet).
     */
    expectedAccountAddr?: string;
    /**
     * Stage F′ (FP-4 P1, RULING-A active anchor): the persisted `agents.init_code_hash`. When
     * provided for a V5 agent, the rebuilt initcode hash MUST equal it — a construction tuple
     * mutated after mint (independent of the stored hash) is refused. Omit at pre-create time.
     */
    initCodeHash?: string;
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
    const version = input.accountVersion ?? 4;
    // PASS 1 — the CREATE2-derivation DEPENDENCIES' identity FIRST (address +
    // bytecode), so a misconfigured / spoofed dependency is refused with a TYPED
    // error BEFORE any predict is attempted. V4 pins the one factory; V5 pins the
    // three singletons (generic deployer + both helpers) baked into the address.
    if (version === 6) {
      await this.assertSingletonsSameAddress(input.chainIds, [
        'create2DeployerAddr', 'signingHelperAddr', 'decodeHelperAddr', 'policyHelperAddr', 'envelopeModuleAddr',
      ]);
    } else if (version === 5) {
      await this.assertV5SingletonsSameAddress(input.chainIds);
    } else {
      await this.assertV4FactorySameAddress(input.chainIds);
    }
    // PASS 2 — CREATE2 predictions + deployed-account bytecode.
    const perChain: Array<{ chainId: number; predicted: string; accountCodehash: string | null }> = [];
    for (const chainId of input.chainIds) {
      const ops = this.getChainOps(chainId);
      const predicted = (
        version === 6
          ? this.predictV6(ops, input)
          : version === 5
            ? this.predictV5(ops, input)
            : await this.predictV4(ops, chainId, input)
      ).toLowerCase();
      perChain.push({ chainId, predicted, accountCodehash: await ops.getCodeHash(predicted) });
    }
    const ref = perChain[0];
    if (!ref) throw new Error('assertSameAddress: unreachable — no chains resolved');
    for (const c of perChain.slice(1)) {
      if (c.predicted !== ref.predicted) {
        throw new SameAddressMismatchError(c.chainId, 'predicted_address', ref.predicted, c.predicted);
      }
    }
    // RULING-A active anchor (Gate-② W-02): bind the prediction to the PERSISTED initcode hash. The
    // tuple the predictions were derived from must hash to the stored anchor — a post-mint tuple drift
    // (which would shift every chain's prediction in lockstep, invisible to the cross-chain check) is
    // refused here. V5 only; omitted at pre-create time (no account/hash yet).
    if (version >= 5 && input.initCodeHash) {
      const hashFn = version === 6
        ? this.getChainOps(ref.chainId).v6InitCodeHash.bind(this.getChainOps(ref.chainId))
        : this.getChainOps(ref.chainId).v5InitCodeHash.bind(this.getChainOps(ref.chainId));
      const rebuilt = hashFn({
        ownerAddr: input.ownerAddr,
        guardianAddr: input.create.guardianAddr,
        sessionKeyAddr: input.create.sessionKeyAddr,
        policy: input.create.policy,
        allowlist: input.create.allowlist,
        timelockDelay: input.create.timelockDelay,
        ...(input.create.settlementToken !== undefined ? { settlementToken: input.create.settlementToken } : {}),
        ...(input.create.tokenPolicy !== undefined ? { tokenPolicy: input.create.tokenPolicy } : {}),
        accountSalt: input.accountSalt,
      }).toLowerCase();
      if (rebuilt !== input.initCodeHash.toLowerCase()) {
        throw new SameAddressMismatchError(ref.chainId, 'init_code_hash', input.initCodeHash.toLowerCase(), rebuilt);
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

  /** V4 PASS 1 — the one factory's identity (address + bytecode) across chains. */
  private async assertV4FactorySameAddress(chainIds: readonly number[]): Promise<void> {
    const factories: Array<{ chainId: number; addr: string; codehash: string | null }> = [];
    for (const chainId of chainIds) {
      const cfg = this.getChainConfig(chainId); // default-deny (E-11)
      const addr = cfg.factoryV4Addr?.toLowerCase();
      if (!addr) throw new SameAddressMismatchError(chainId, 'factory_missing', 'a configured V4 factory', 'none');
      factories.push({ chainId, addr, codehash: await this.getChainOps(chainId).getCodeHash(addr) });
    }
    const ref = factories[0];
    if (!ref) throw new Error('assertSameAddress: unreachable — no chains resolved');
    if (ref.codehash === null) {
      throw new SameAddressMismatchError(ref.chainId, 'factory_codehash', 'deployed factory bytecode', 'no code');
    }
    for (const f of factories.slice(1)) {
      if (f.addr !== ref.addr) throw new SameAddressMismatchError(f.chainId, 'factory_addr', ref.addr, f.addr);
      if (f.codehash !== ref.codehash) {
        throw new SameAddressMismatchError(f.chainId, 'factory_codehash', ref.codehash, f.codehash ?? 'no code');
      }
    }
  }

  /**
   * AQ-FND V6 PASS 1 — the generalized singleton pin: every named ChainConfig singleton must
   * be at the SAME address with the SAME bytecode on every chain (absent ⇒ refusal). V6 pins
   * FIVE (deployer + SigningLib + DecodeLib + PolicyLib + EnvelopeModule) — all are part of
   * the account's CREATE2 preimage or its authority surface.
   */
  private async assertSingletonsSameAddress(
    chainIds: readonly number[],
    kinds: readonly ('create2DeployerAddr' | 'signingHelperAddr' | 'decodeHelperAddr' | 'policyHelperAddr' | 'envelopeModuleAddr')[],
  ): Promise<void> {
    for (const kind of kinds) {
      const rows: Array<{ chainId: number; addr: string; codehash: string | null }> = [];
      for (const chainId of chainIds) {
        const addr = this.getChainConfig(chainId)[kind]?.toLowerCase();
        if (!addr) throw new SameAddressMismatchError(chainId, 'singleton_missing', kind, 'none');
        rows.push({ chainId, addr, codehash: await this.getChainOps(chainId).getCodeHash(addr) });
      }
      const ref = rows[0];
      if (!ref) throw new Error('assertSameAddress: unreachable — no chains resolved');
      if (ref.codehash === null) {
        throw new SameAddressMismatchError(ref.chainId, 'singleton_codehash', `${kind} bytecode`, 'no code');
      }
      for (const r of rows.slice(1)) {
        if (r.addr !== ref.addr) throw new SameAddressMismatchError(r.chainId, 'singleton_addr', `${kind} ${ref.addr}`, r.addr);
        if (r.codehash !== ref.codehash) {
          throw new SameAddressMismatchError(r.chainId, 'singleton_codehash', `${kind} ${ref.codehash}`, r.codehash ?? 'no code');
        }
      }
    }
  }

  /** V6 per-chain CREATE2 prediction — PURE off-chain, from the persisted tuple (same shape as V5). */
  private predictV6(
    ops: LeashChainOps,
    input: { ownerAddr: string; accountSalt: string; create: SameAddressCreateInput },
  ): string {
    return ops.predictAccountV6({
      ownerAddr: input.ownerAddr,
      guardianAddr: input.create.guardianAddr,
      sessionKeyAddr: input.create.sessionKeyAddr,
      policy: input.create.policy,
      allowlist: input.create.allowlist,
      timelockDelay: input.create.timelockDelay,
      ...(input.create.settlementToken !== undefined ? { settlementToken: input.create.settlementToken } : {}),
      ...(input.create.tokenPolicy !== undefined ? { tokenPolicy: input.create.tokenPolicy } : {}),
      accountSalt: input.accountSalt,
    });
  }

  /**
   * V5 PASS 1 (FP-4 P1 / THREAT 4) — the THREE pinned singletons (generic deployer
   * + SigningLib + DecodeLib) must each be at the SAME address with the SAME
   * bytecode on every chain; an absent singleton on any chain is a REFUSAL. Each is
   * part of the account's CREATE2 preimage (deployer in the formula, helpers in the
   * initcode), so divergence means funds would land outside the proven wall.
   */
  private async assertV5SingletonsSameAddress(chainIds: readonly number[]): Promise<void> {
    const kinds = ['create2DeployerAddr', 'signingHelperAddr', 'decodeHelperAddr'] as const;
    for (const kind of kinds) {
      const rows: Array<{ chainId: number; addr: string; codehash: string | null }> = [];
      for (const chainId of chainIds) {
        const addr = this.getChainConfig(chainId)[kind]?.toLowerCase();
        if (!addr) throw new SameAddressMismatchError(chainId, 'singleton_missing', kind, 'none');
        rows.push({ chainId, addr, codehash: await this.getChainOps(chainId).getCodeHash(addr) });
      }
      const ref = rows[0];
      if (!ref) throw new Error('assertSameAddress: unreachable — no chains resolved');
      if (ref.codehash === null) {
        throw new SameAddressMismatchError(ref.chainId, 'singleton_codehash', `${kind} bytecode`, 'no code');
      }
      for (const r of rows.slice(1)) {
        if (r.addr !== ref.addr) throw new SameAddressMismatchError(r.chainId, 'singleton_addr', `${kind} ${ref.addr}`, r.addr);
        if (r.codehash !== ref.codehash) {
          throw new SameAddressMismatchError(r.chainId, 'singleton_codehash', `${kind} ${ref.codehash}`, r.codehash ?? 'no code');
        }
      }
    }
  }

  /** V4 per-chain CREATE2 prediction (eth_call); a revert → typed refusal, not a raw throw. */
  private async predictV4(
    ops: LeashChainOps,
    chainId: number,
    input: { ownerAddr: string; accountSalt: string; create: SameAddressCreateInput },
  ): Promise<string> {
    try {
      return await ops.predictAccountV4({
        ownerAddr: input.ownerAddr,
        sessionKeyAddr: input.create.sessionKeyAddr,
        guardianAddr: input.create.guardianAddr,
        policy: input.create.policy,
        allowlist: input.create.allowlist,
        timelockDelay: input.create.timelockDelay,
        ...(input.create.settlementToken !== undefined ? { settlementToken: input.create.settlementToken } : {}),
        ...(input.create.tokenPolicy !== undefined ? { tokenPolicy: input.create.tokenPolicy } : {}),
        accountSalt: input.accountSalt,
      });
    } catch (err) {
      throw new SameAddressMismatchError(
        chainId,
        'predicted_address',
        'a CREATE2 prediction',
        `predict reverted (${err instanceof Error ? err.message.slice(0, 80) : String(err).slice(0, 80)})`,
      );
    }
  }

  /** V5 per-chain CREATE2 prediction — PURE off-chain (no eth_call); uses the chain's singletons. */
  private predictV5(
    ops: LeashChainOps,
    input: { ownerAddr: string; accountSalt: string; create: SameAddressCreateInput },
  ): string {
    return ops.predictAccountV5({
      ownerAddr: input.ownerAddr,
      guardianAddr: input.create.guardianAddr,
      sessionKeyAddr: input.create.sessionKeyAddr,
      policy: input.create.policy,
      allowlist: input.create.allowlist,
      timelockDelay: input.create.timelockDelay,
      ...(input.create.settlementToken !== undefined ? { settlementToken: input.create.settlementToken } : {}),
      ...(input.create.tokenPolicy !== undefined ? { tokenPolicy: input.create.tokenPolicy } : {}),
      accountSalt: input.accountSalt,
    });
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

  /** AQ-FND M-3: the ops relayer's address (public; the key never leaves the registry). */
  getOpsRelayerAddr(): string {
    return privateKeyToAccount(this.signing.opsPrivateKey as Hex).address;
  }

  /** AQ-FND M-3 inc-2: the read-only surface the gas-route survey (owner route) needs. */
  getGasRouteSurface(): GasRouteSurface {
    return {
      has: (chainId) => this.has(chainId),
      getChainConfig: (chainId) => this.getChainConfig(chainId),
      getSessionChain: (chainId) => this.getSessionChain(chainId),
      opsRelayerAddr: this.getOpsRelayerAddr(),
    };
  }

  /**
   * AQ-FND M-3 rung-4: the EIP-7702 bootstrap primitives for a chain, or null when the
   * chain declares no GasRepayDelegate (bootstrap unavailable → the ladder asks the
   * owner, fail-closed). The ops key stays INSIDE the registry — the runtime receives
   * only ready-built wallet clients, never the key. A test-injected client is reused so
   * hermetic tests do not dial RPC.
   */
  getBootstrapGas(chainId: number): BootstrapGasPrimitives | null {
    const c = this.getChainConfig(chainId);
    if (!c.gasRepayDelegateAddr) return null;
    const clients = this.testClients.get(chainId);
    const viemChain = zeroGChain(c.rpcUrl, c.chainId);
    const opsAccount = privateKeyToAccount(this.signing.opsPrivateKey as Hex);
    const publicClient = clients?.publicClient ?? createPublicClient({ chain: viemChain, transport: http(c.rpcUrl) });
    const opsWallet = clients?.opsWallet ?? createWalletClient({ chain: viemChain, transport: http(c.rpcUrl), account: opsAccount });
    return {
      publicClient,
      opsWallet,
      opsRelayerAddr: opsAccount.address,
      delegate: c.gasRepayDelegateAddr,
      buildSessionWallet: (sessionPrivateKey: string) =>
        createWalletClient({ chain: viemChain, transport: http(c.rpcUrl), account: privateKeyToAccount(sessionPrivateKey as Hex) }),
    };
  }
}

// Re-export so callers can depend on the registry module for the ops contract.
export type { ChainOps };
