import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseEventLogs,
  keccak256,
  type Chain,
  type PublicClient,
  type WalletClient,
  type Account,
  type Hex,
} from 'viem';
import { waitReceipt } from './wait-receipt.js';
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import {
  factoryAbi,
  factoryV4DeterministicAbi,
  registryAbi,
  leashAccountAbi,
  create2DeployerAbi,
  leashAccountV5ReadAbi,
} from './abis.js';
import { buildV5Initcode, ownerScopedSalt, predictCreate2Address } from './v5-initcode.js';
import type { AccountCreateTuple, ChainOps } from '../server.js';
import type { PolicyView } from '../types.js';

export interface LeashChainOptions {
  rpcUrl: string;
  chainId: number;
  opsPrivateKey: string;
  /** C-1: dedicated revoke-only guardian key — its own signer + nonce space. */
  guardianPrivateKey: string;
  /**
   * Legacy v2 factory. SE-7: optional — a V4-only chain (Base Sepolia) has
   * none; a legacy create there throws loudly instead of minting anywhere.
   */
  factoryAddr?: string;
  /**
   * SE-1 (Stage E): the dedicated V4 (governed-calldata) factory. Selected for
   * accountVersion=4 creates. Forward-compatible with SE-6 (BR-1): swapping in a
   * deterministic CREATE2 factory is a config change to this address alone.
   * Optional so legacy-only setups (v2 accounts) still boot.
   */
  factoryV4Addr?: string;
  /**
   * Stage F′ (FP-4 P1): the generic CREATE2 deployer address. V5 creates mint
   * through it with backend-assembled initcode. Optional so legacy/V4-only setups
   * boot; a V5 create with this unset throws loudly (default-deny).
   */
  create2DeployerAddr?: string;
  /** Stage F′ (RULING-B): canonical SigningLib singleton baked into V5 initcode + read-back-asserted. */
  signingHelperAddr?: string;
  /** Stage F′ (RULING-B): canonical DecodeLib singleton baked into V5 initcode + read-back-asserted. */
  decodeHelperAddr?: string;
  registryAddr: string;
  /** Test seam: inject fake clients instead of dialing an RPC. */
  clients?: {
    publicClient: PublicClient;
    opsWallet: WalletClient;
    guardianWallet: WalletClient;
  };
}

export function zeroGChain(rpcUrl: string, chainId: number): Chain {
  return defineChain({
    id: chainId,
    name: '0G Galileo Testnet',
    nativeCurrency: { name: '0G', symbol: '0G', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

/**
 * On-chain operations, split into TWO independently-nonced signing lanes (C-1):
 * - DEPLOYER lane (ops key): creates, registry writes, session-key funding —
 *   the queueing lane; serialized through its own mutex.
 * - GUARDIAN lane (guardian key): revoke ONLY — its own signer, its own nonce
 *   space, its own mutex. Incident response can never queue behind creates
 *   because it is a different signer.
 * Neither key holds authority to move or govern user funds (non-custodial
 * invariant, spec §6): ops deploys and funds gas dust; guardian can only
 * refuse (revoke). New accounts get `guardian = guardian key`; legacy Phase-1
 * accounts keep the ops-key guardian — revoke() picks the matching signer by
 * the account's stored guardian address (S7, no forced migration).
 */
export class LeashChainOps implements ChainOps {
  private readonly publicClient: PublicClient;
  private readonly opsWallet: WalletClient;
  private readonly guardianWallet: WalletClient;
  private readonly opsAccount: Account;
  private readonly guardianAccount: Account;
  private opsTxChain: Promise<unknown> = Promise.resolve();
  private guardianTxChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: LeashChainOptions) {
    const chain = zeroGChain(opts.rpcUrl, opts.chainId);
    this.opsAccount = privateKeyToAccount(opts.opsPrivateKey as Hex);
    this.guardianAccount = privateKeyToAccount(opts.guardianPrivateKey as Hex);
    if (opts.clients) {
      this.publicClient = opts.clients.publicClient;
      this.opsWallet = opts.clients.opsWallet;
      this.guardianWallet = opts.clients.guardianWallet;
    } else {
      this.publicClient = createPublicClient({ chain, transport: http(opts.rpcUrl) });
      this.opsWallet = createWalletClient({ chain, transport: http(opts.rpcUrl), account: this.opsAccount });
      this.guardianWallet = createWalletClient({ chain, transport: http(opts.rpcUrl), account: this.guardianAccount });
    }
  }

  get opsAddress(): string {
    return this.opsAccount.address;
  }

  /**
   * SE-9 (L-02): the destination chain's SELF-REPORTED chain id (`eth_chainId`).
   * The bridge pre-routing gate cross-checks this against the configured
   * destination id so destination-RPC trust is self-verifying, not an
   * operator-config boundary (a mis-pointed RPC can never silently route a bridge
   * to the wrong chain).
   */
  async getChainId(): Promise<number> {
    return this.publicClient.getChainId();
  }

  get guardianAddress(): string {
    return this.guardianAccount.address;
  }

  private serializeOps<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.opsTxChain.then(fn, fn);
    this.opsTxChain = next.catch(() => undefined);
    return next;
  }

  private serializeGuardian<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.guardianTxChain.then(fn, fn);
    this.guardianTxChain = next.catch(() => undefined);
    return next;
  }

  async deployAndRegister(input: Parameters<ChainOps['deployAndRegister']>[0]): ReturnType<ChainOps['deployAndRegister']> {
    // Stage F′ (FP-4 P1): V5 mints through the generic CREATE2 deployer with
    // backend-assembled initcode — a wholly different create path than the typed
    // V4/legacy factories, so it has its own method (both share the registry write).
    if (input.accountVersion === 5) {
      return this.serializeOps(() => this.deployAndRegisterV5(input));
    }
    return this.serializeOps(async () => {
      // SE-1 (SD-E7): select factory address + fn/event by account version.
      // SE-6: the V4 factory is the DETERMINISTIC (CREATE2) one — the wire gains
      // a trailing bytes32 salt (server-generated, never caller/model text) and a
      // predict-verify step: the minted address must equal the CREATE2 prediction
      // (spec §8 CREATE2 address-spoof — a wrong-bytecode/wrong-tuple mint can
      // never bind). Legacy v2 stays on the plain `createAccount` wire.
      const isV4 = input.accountVersion === 4;
      const v4Addr = this.opts.factoryV4Addr;
      if (isV4 && !v4Addr) {
        throw new Error('accountVersion=4 requested but no V4 factory configured (LEASH_FACTORY_V4_ADDR)');
      }
      if (!isV4 && !this.opts.factoryAddr) {
        // SE-7: V4-only chains (Base) carry no legacy factory — refuse loudly.
        throw new Error(`legacy (v${input.accountVersion}) create requested but chain ${this.opts.chainId} has no legacy factory configured`);
      }
      const createAddr = (isV4 ? (v4Addr as string) : (this.opts.factoryAddr as string)) as Hex;
      // The per-agent CREATE2 salt: reused verbatim on every chain this agent
      // onboards so the account lands at the SAME address (E-6). Fresh random
      // 32 bytes when the caller supplies none (a first-chain create).
      const accountSalt = (
        isV4 ? (input.accountSalt ?? `0x${randomBytes(32).toString('hex')}`) : null
      ) as Hex | null;
      const constructionArgs = [
        input.ownerAddr as Hex,
        this.guardianAccount.address, // C-1: NEW accounts get the dedicated guardian key
        input.sessionKeyAddr as Hex,
        {
          perTransferCap: input.policy.perTransferCap,
          windowCap: input.policy.windowCap,
          windowSeconds: input.policy.windowSeconds,
          expiresAt: BigInt(input.policy.expiresAt),
        },
        input.allowlist as Hex[],
        BigInt(input.timelockDelay),
        (input.settlementToken ?? '0x0000000000000000000000000000000000000000') as Hex,
        {
          perTransferCapToken: input.tokenPolicy?.perTransferCapToken ?? 0n,
          windowCapToken: input.tokenPolicy?.windowCapToken ?? 0n,
        },
      ] as const;
      // Predict BEFORE the mint — the deterministic address the event must match.
      const predicted =
        isV4 && accountSalt
          ? ((await this.publicClient.readContract({
              address: createAddr,
              abi: factoryV4DeterministicAbi,
              functionName: 'predictAccountV4',
              args: [...constructionArgs, accountSalt],
            })) as string)
          : null;
      // Adopt-existing (security M-02): createAccountV4 is permissionless and the
      // tuple+salt are public after the first chain's mint, so a griefer can
      // pre-deploy the (owner, salt) slot on another chain. CREATE2 makes that
      // harmless — code can exist at the prediction ONLY if the byte-exact
      // initcode (this exact tuple, this owner's authority state) deployed it —
      // so we ADOPT the existing account instead of letting the factory revert
      // AccountAlreadyDeployed and strand the onboard (the grief becomes a gas
      // subsidy). Registration still runs below.
      let adopted = false;
      let accountAddr: Hex;
      let createHash: Hex;
      const preExisting = predicted ? await this.publicClient.getCode({ address: predicted as Hex }) : undefined;
      if (predicted && preExisting && preExisting !== '0x') {
        adopted = true;
        accountAddr = predicted as Hex;
        createHash = `0x${'0'.repeat(64)}`; // no mint tx — adopted a pre-existing deterministic deploy
      } else {
        createHash = await this.opsWallet.writeContract({
          chain: this.opsWallet.chain,
          account: this.opsAccount,
          address: createAddr,
          abi: isV4 ? factoryV4DeterministicAbi : factoryAbi,
          functionName: isV4 ? 'createAccountV4' : 'createAccount',
          args: isV4 && accountSalt ? [...constructionArgs, accountSalt] : [...constructionArgs],
        });
        const createReceipt = await waitReceipt(this.publicClient, createHash);
        // Bind the event from the factory we actually called (address-filtered) so
        // a co-emitted same-shape event in the tx can never bind the wrong address.
        const createLogs = createReceipt.logs.filter(
          (l) => l.address.toLowerCase() === createAddr.toLowerCase(),
        );
        const created = isV4
          ? parseEventLogs({ abi: factoryV4DeterministicAbi, logs: createLogs, eventName: 'AccountCreatedV4' })[0]
          : parseEventLogs({ abi: factoryAbi, logs: createLogs, eventName: 'AccountCreated' })[0];
        if (!created) {
          throw new Error(
            `factory ${isV4 ? 'createAccountV4' : 'createAccount'} emitted no ${isV4 ? 'AccountCreatedV4' : 'AccountCreated'} event`,
          );
        }
        accountAddr = created.args.account;
        if (predicted && accountAddr.toLowerCase() !== predicted.toLowerCase()) {
          // Deterministic-deploy integrity: the mint landed off-prediction — refuse
          // to bind rather than record an unverifiable account (address-spoof guard).
          throw new Error(
            `deterministic V4 mint mismatch: event account ${accountAddr} != CREATE2 prediction ${predicted}`,
          );
        }
      }

      const auditPubKeyHex = (
        input.auditPubKey.startsWith('0x') ? input.auditPubKey : `0x${input.auditPubKey}`
      ) as Hex;
      const registerHash = await this.opsWallet.writeContract({
        chain: this.opsWallet.chain,
        account: this.opsAccount,
        address: this.opts.registryAddr as Hex,
        abi: registryAbi,
        functionName: 'register',
        args: [accountAddr, input.sessionKeyAddr as Hex, auditPubKeyHex, input.name],
      });
      const registerReceipt = await waitReceipt(this.publicClient, registerHash);
      const registered = parseEventLogs({ abi: registryAbi, logs: registerReceipt.logs, eventName: 'AgentRegistered' })[0];
      if (!registered) throw new Error('registry register emitted no AgentRegistered event');

      return {
        accountAddr,
        chainAgentId: registered.args.agentId,
        createTx: createHash,
        registerTx: registerHash,
        guardianAddr: this.guardianAccount.address,
        // The version actually minted — derived from the branch that produced a
        // valid AccountCreated(V4) event, so the DB record is causally tied to
        // the on-chain mint, not a re-assertion of the request (gate L-01).
        accountVersion: isV4 ? 4 : 2,
        // SE-6: the CREATE2 salt actually used (null for legacy mints) — persisted
        // so onboarding the agent to another chain reuses it (same address).
        accountSalt,
        // SE-6 (code-review W2): the EXACT canonical construction tuple this mint
        // used, serializable — persisted so a later chain onboard replays it
        // verbatim (it is baked into the CREATE2 initcode; a reconstructed tuple
        // with a time-derived expiry would predict a different address).
        accountCreateTuple: isV4
          ? {
              ownerAddr: input.ownerAddr.toLowerCase(),
              guardianAddr: this.guardianAccount.address.toLowerCase(),
              sessionKeyAddr: input.sessionKeyAddr.toLowerCase(),
              policy: {
                perTransferCap: input.policy.perTransferCap.toString(),
                windowCap: input.policy.windowCap.toString(),
                windowSeconds: input.policy.windowSeconds,
                expiresAt: input.policy.expiresAt,
              },
              allowlist: input.allowlist.map((a) => a.toLowerCase()),
              timelockDelay: input.timelockDelay,
              settlementToken: (input.settlementToken ?? '0x0000000000000000000000000000000000000000').toLowerCase(),
              tokenPolicy: {
                perTransferCapToken: (input.tokenPolicy?.perTransferCapToken ?? 0n).toString(),
                windowCapToken: (input.tokenPolicy?.windowCapToken ?? 0n).toString(),
              },
            }
          : null,
        // Stage F′ (RULING-A): V4/legacy predict is factory-side, not an off-chain
        // initcode — no persisted initcode hash (null; V5 carries the real value).
        initCodeHash: null,
        // SE-6 (security M-02): true when a pre-existing deterministic deploy at
        // the predicted address was adopted (no mint tx; createTx is the zero hash).
        adopted,
      };
    });
  }

  /**
   * Stage F′ (FP-4 P1) — mint a V5 account through the generic `Create2Deployer`.
   * Mirrors the V4 deterministic pattern (predict → adopt-or-deploy → bind event →
   * refuse-on-mismatch) but the initcode is assembled OFF-CHAIN from the committed
   * creationCode + the ctor args, and the three singletons come from ChainConfig,
   * NOT the request (RULING-B). RULING-A: the EXACT initcode's keccak is returned
   * (persisted) so cross-chain verification compares a fixed hash. Serialized by
   * the ops mutex (its one caller wraps it in `serializeOps`).
   */
  private async deployAndRegisterV5(
    input: Parameters<ChainOps['deployAndRegister']>[0],
  ): ReturnType<ChainOps['deployAndRegister']> {
    const built = await this.buildV5Deploy(input);
    const { accountAddr, createHash, adopted, initcode, accountSalt } = built;
    // RULING-B: read the account's immutables back BEFORE registering/returning —
    // owner + the two helpers MUST equal the input owner + the canonical config
    // helpers, or funds would route to an account whose authority we never proved.
    await this.assertV5ReadBack(accountAddr, input.ownerAddr);
    const register = await this.registerAgent(input, accountAddr);
    return {
      accountAddr,
      chainAgentId: register.chainAgentId,
      createTx: createHash,
      registerTx: register.registerTx,
      guardianAddr: this.guardianAccount.address,
      accountVersion: 5,
      accountSalt,
      accountCreateTuple: this.v5CreateTuple(input),
      // RULING-A: the fixed hash of the exact deployed initcode (cross-chain anchor).
      initCodeHash: keccak256(initcode),
      adopted,
    };
  }

  /**
   * Build the V5 initcode + owner-scoped salt, predict the address off-chain,
   * cross-check the on-chain `predict`, then adopt-existing or deploy via the
   * generic deployer (binding the address-filtered `Deployed` event, refusing on
   * any mismatch — the V4 address-spoof guard, ported to the generic path).
   */
  private async buildV5Deploy(input: Parameters<ChainOps['deployAndRegister']>[0]): Promise<{
    accountAddr: Hex;
    createHash: Hex;
    adopted: boolean;
    initcode: Hex;
    accountSalt: Hex;
  }> {
    const deployerAddr = this.opts.create2DeployerAddr;
    const signingHelperAddr = this.opts.signingHelperAddr;
    const decodeHelperAddr = this.opts.decodeHelperAddr;
    if (!deployerAddr || !signingHelperAddr || !decodeHelperAddr) {
      // Default-deny: a half-wired V5 chain must refuse, never mint off a zero helper.
      throw new Error(
        `accountVersion=5 requested but chain ${this.opts.chainId} is missing a V5 singleton (deployer/signingHelper/decodeHelper)`,
      );
    }
    const agentSalt = (input.accountSalt ?? `0x${randomBytes(32).toString('hex')}`) as Hex;
    const salt = ownerScopedSalt(input.ownerAddr, agentSalt);
    const initcode = buildV5Initcode({
      ownerAddr: input.ownerAddr,
      guardianAddr: this.guardianAccount.address,
      sessionKeyAddr: input.sessionKeyAddr,
      policy: input.policy,
      allowlist: input.allowlist,
      timelockDelay: input.timelockDelay,
      ...(input.settlementToken !== undefined ? { settlementToken: input.settlementToken } : {}),
      ...(input.tokenPolicy !== undefined ? { tokenPolicy: input.tokenPolicy } : {}),
      signingHelperAddr,
      decodeHelperAddr,
    });
    const predicted = predictCreate2Address(deployerAddr, salt, initcode);
    await this.crossCheckOnChainPredict(deployerAddr as Hex, salt, keccak256(initcode), predicted);
    const deploy = await this.adoptOrDeployV5(deployerAddr as Hex, salt, initcode, predicted);
    return { accountAddr: predicted, initcode, accountSalt: agentSalt, ...deploy };
  }

  /**
   * Stage F′ (FP-4 P1): the V5 analogue of `predictAccountV4` — a PURE off-chain
   * CREATE2 derivation from the persisted construction tuple + salt, used by
   * `assertSameAddress`. No eth_call: `f(deployer, ownerScopedSalt(owner, agentSalt),
   * keccak256(initcode))`. The deployer + helpers come from this lane's ChainConfig.
   */
  predictAccountV5(input: {
    ownerAddr: string;
    guardianAddr: string;
    sessionKeyAddr: string;
    policy: { perTransferCap: bigint; windowCap: bigint; windowSeconds: number; expiresAt: number };
    allowlist: string[];
    timelockDelay: number;
    settlementToken?: string;
    tokenPolicy?: { perTransferCapToken: bigint; windowCapToken: bigint };
    accountSalt: string;
  }): string {
    const deployerAddr = this.opts.create2DeployerAddr;
    const signingHelperAddr = this.opts.signingHelperAddr;
    const decodeHelperAddr = this.opts.decodeHelperAddr;
    if (!deployerAddr || !signingHelperAddr || !decodeHelperAddr) {
      throw new Error(`predictAccountV5: chain ${this.opts.chainId} is missing a V5 singleton`);
    }
    const initcode = buildV5Initcode({
      ownerAddr: input.ownerAddr,
      guardianAddr: input.guardianAddr,
      sessionKeyAddr: input.sessionKeyAddr,
      policy: input.policy,
      allowlist: input.allowlist,
      timelockDelay: input.timelockDelay,
      ...(input.settlementToken !== undefined ? { settlementToken: input.settlementToken } : {}),
      ...(input.tokenPolicy !== undefined ? { tokenPolicy: input.tokenPolicy } : {}),
      signingHelperAddr,
      decodeHelperAddr,
    });
    const salt = ownerScopedSalt(input.ownerAddr, input.accountSalt);
    return predictCreate2Address(deployerAddr, salt, initcode);
  }

  /**
   * RULING-A active anchor (Gate-② W-02): the keccak256 of the V5 initcode this lane would build for
   * `input`. `assertSameAddress` compares it to the PERSISTED `agents.init_code_hash` so a construction
   * tuple mutated AFTER mint (independent of the stored hash) is refused — the hash stops being a mere
   * audit artifact and becomes a tuple-drift-immune check. Same build as `predictAccountV5`.
   */
  v5InitCodeHash(input: Parameters<LeashChainOps['predictAccountV5']>[0]): Hex {
    const signingHelperAddr = this.opts.signingHelperAddr;
    const decodeHelperAddr = this.opts.decodeHelperAddr;
    if (!signingHelperAddr || !decodeHelperAddr) {
      throw new Error(`v5InitCodeHash: chain ${this.opts.chainId} is missing a V5 helper singleton`);
    }
    return keccak256(buildV5Initcode({
      ownerAddr: input.ownerAddr,
      guardianAddr: input.guardianAddr,
      sessionKeyAddr: input.sessionKeyAddr,
      policy: input.policy,
      allowlist: input.allowlist,
      timelockDelay: input.timelockDelay,
      ...(input.settlementToken !== undefined ? { settlementToken: input.settlementToken } : {}),
      ...(input.tokenPolicy !== undefined ? { tokenPolicy: input.tokenPolicy } : {}),
      signingHelperAddr,
      decodeHelperAddr,
    }));
  }

  /** The configured V5 singletons (null when the chain is not V5-enabled). */
  get v5Singletons(): { create2DeployerAddr: string; signingHelperAddr: string; decodeHelperAddr: string } | null {
    const { create2DeployerAddr, signingHelperAddr, decodeHelperAddr } = this.opts;
    if (!create2DeployerAddr || !signingHelperAddr || !decodeHelperAddr) return null;
    return { create2DeployerAddr, signingHelperAddr, decodeHelperAddr };
  }

  /** RH2 (V5 migration): all three V5 singletons wired ⇒ an accountVersion:5 mint can land. */
  supportsV5(): boolean {
    return this.v5Singletons !== null;
  }

  /** Cross-check: the on-chain deployer.predict must agree with our off-chain CREATE2. */
  private async crossCheckOnChainPredict(deployerAddr: Hex, salt: Hex, initCodeHash: Hex, predicted: Hex): Promise<void> {
    const onchain = (await this.publicClient.readContract({
      address: deployerAddr,
      abi: create2DeployerAbi,
      functionName: 'predict',
      args: [salt, initCodeHash],
    })) as string;
    if (onchain.toLowerCase() !== predicted.toLowerCase()) {
      throw new Error(`V5 CREATE2 prediction mismatch: off-chain ${predicted} != deployer.predict ${onchain}`);
    }
  }

  /**
   * Adopt a pre-existing deterministic deploy (same initcode → harmless front-run,
   * zero createTx) or deploy via the generic deployer. The `Deployed` event is
   * address-filtered to the deployer and its `account` MUST equal the prediction.
   */
  private async adoptOrDeployV5(
    deployerAddr: Hex,
    salt: Hex,
    initcode: Hex,
    predicted: Hex,
  ): Promise<{ createHash: Hex; adopted: boolean }> {
    const preExisting = await this.publicClient.getCode({ address: predicted });
    if (preExisting && preExisting !== '0x') {
      return { createHash: `0x${'0'.repeat(64)}`, adopted: true };
    }
    const createHash = await this.opsWallet.writeContract({
      chain: this.opsWallet.chain,
      account: this.opsAccount,
      address: deployerAddr,
      abi: create2DeployerAbi,
      functionName: 'deploy',
      args: [salt, initcode],
    });
    const receipt = await waitReceipt(this.publicClient, createHash);
    const logs = receipt.logs.filter((l) => l.address.toLowerCase() === deployerAddr.toLowerCase());
    const deployed = parseEventLogs({ abi: create2DeployerAbi, logs, eventName: 'Deployed' })[0];
    if (!deployed) throw new Error('Create2Deployer.deploy emitted no Deployed event');
    if (deployed.args.account.toLowerCase() !== predicted.toLowerCase()) {
      throw new Error(`V5 deploy mismatch: Deployed.account ${deployed.args.account} != prediction ${predicted}`);
    }
    return { createHash, adopted: false };
  }

  /**
   * RULING-B post-deploy read-back: `owner()` == the input owner and the two helper
   * immutables == the canonical ChainConfig helpers. Refuses (throws) legibly on any
   * divergence — restores the correctness guarantee the typed factory gave for free.
   */
  /** Retry a read that can transiently return empty/0x on a load-balanced RPC just after a deploy.
   * Returns a non-empty address once available; returns the last (possibly empty) value after N tries
   * so the caller's equality check still fails-closed on a genuinely empty/divergent read. */
  private async retryRead(read: () => Promise<Hex>, tries = 4, delayMs = 1000): Promise<Hex> {
    let last: Hex = '0x';
    for (let i = 0; i < tries; i++) {
      try {
        last = await read();
        if (last && last.length === 42 && last !== '0x') return last;
      } catch {
        /* zero-data / transient from a lagging replica — retry */
      }
      if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
    return last;
  }

  private async assertV5ReadBack(accountAddr: Hex, ownerAddr: string): Promise<void> {
    // Read each immutable with a short retry: a load-balanced RPC (Base drpc) can route a read to a
    // replica that has not yet indexed the just-mined deploy and return 0x — a spurious hard-fail of a
    // VALID deploy. Retry closes that liveness gap; it never relaxes the check (a real divergence still
    // throws below, and a persistently-empty read stays empty → still throws). Fail-closed throughout.
    const read = (fn: 'owner' | 'signingHelper' | 'decodeHelper') =>
      this.retryRead(() => this.publicClient.readContract({ address: accountAddr, abi: leashAccountV5ReadAbi, functionName: fn }));
    const [owner, signingHelper, decodeHelper] = await Promise.all([read('owner'), read('signingHelper'), read('decodeHelper')]);
    const want: Array<[string, string, string | undefined]> = [
      ['owner', owner, ownerAddr],
      ['signingHelper', signingHelper, this.opts.signingHelperAddr],
      ['decodeHelper', decodeHelper, this.opts.decodeHelperAddr],
    ];
    for (const [field, got, expected] of want) {
      if (!expected || got.toLowerCase() !== expected.toLowerCase()) {
        throw new Error(`V5 read-back REFUSED: account ${accountAddr} ${field} ${got} != canonical ${expected ?? 'unset'}`);
      }
    }
  }

  /** The serializable V5 construction tuple (canonical, bigints→strings) — RULING-A persistence. */
  private v5CreateTuple(input: Parameters<ChainOps['deployAndRegister']>[0]): AccountCreateTuple {
    return {
      ownerAddr: input.ownerAddr.toLowerCase(),
      guardianAddr: this.guardianAccount.address.toLowerCase(),
      sessionKeyAddr: input.sessionKeyAddr.toLowerCase(),
      policy: {
        perTransferCap: input.policy.perTransferCap.toString(),
        windowCap: input.policy.windowCap.toString(),
        windowSeconds: input.policy.windowSeconds,
        expiresAt: input.policy.expiresAt,
      },
      allowlist: input.allowlist.map((a) => a.toLowerCase()),
      timelockDelay: input.timelockDelay,
      settlementToken: (input.settlementToken ?? '0x0000000000000000000000000000000000000000').toLowerCase(),
      tokenPolicy: {
        perTransferCapToken: (input.tokenPolicy?.perTransferCapToken ?? 0n).toString(),
        windowCapToken: (input.tokenPolicy?.windowCapToken ?? 0n).toString(),
      },
    };
  }

  /** Register the (account, sessionKey, auditPubKey, name) on the chain registry — shared V4/V5. */
  private async registerAgent(
    input: Parameters<ChainOps['deployAndRegister']>[0],
    accountAddr: Hex,
  ): Promise<{ chainAgentId: bigint; registerTx: Hex }> {
    const auditPubKeyHex = (
      input.auditPubKey.startsWith('0x') ? input.auditPubKey : `0x${input.auditPubKey}`
    ) as Hex;
    const registerTx = await this.opsWallet.writeContract({
      chain: this.opsWallet.chain,
      account: this.opsAccount,
      address: this.opts.registryAddr as Hex,
      abi: registryAbi,
      functionName: 'register',
      args: [accountAddr, input.sessionKeyAddr as Hex, auditPubKeyHex, input.name],
    });
    const receipt = await waitReceipt(this.publicClient, registerTx);
    const registered = parseEventLogs({ abi: registryAbi, logs: receipt.logs, eventName: 'AgentRegistered' })[0];
    if (!registered) throw new Error('registry register emitted no AgentRegistered event');
    return { chainAgentId: registered.args.agentId, registerTx };
  }

  /** SE-6: the configured deterministic V4 factory address (null = not configured). */
  get factoryV4Address(): string | null {
    return this.opts.factoryV4Addr ?? null;
  }

  /**
   * SE-6: eth_call the deterministic factory's CREATE2 prediction for a
   * construction tuple — the per-chain half of `assertSameAddress`. Uses the
   * SAME guardian key this lane would mint with, so the prediction matches what
   * `deployAndRegister` would actually deploy on this chain.
   */
  async predictAccountV4(
    input: Omit<Parameters<ChainOps['deployAndRegister']>[0], 'accountVersion' | 'auditPubKey' | 'name'> & {
      accountSalt: string;
      /**
       * The CREATE-TIME guardian (persisted `agents.guardian_addr`). When
       * omitted, the lane's current guardian key is used (create-time predict).
       * A later verification MUST pass the persisted value (security M-01): a
       * rotated guardian key would silently shift every prediction.
       */
      guardianAddr?: string;
    },
  ): Promise<string> {
    const v4Addr = this.opts.factoryV4Addr;
    if (!v4Addr) throw new Error('predictAccountV4: no V4 factory configured on this chain');
    return (await this.publicClient.readContract({
      address: v4Addr as Hex,
      abi: factoryV4DeterministicAbi,
      functionName: 'predictAccountV4',
      args: [
        input.ownerAddr as Hex,
        (input.guardianAddr ?? this.guardianAccount.address) as Hex,
        input.sessionKeyAddr as Hex,
        {
          perTransferCap: input.policy.perTransferCap,
          windowCap: input.policy.windowCap,
          windowSeconds: input.policy.windowSeconds,
          expiresAt: BigInt(input.policy.expiresAt),
        },
        input.allowlist as Hex[],
        BigInt(input.timelockDelay),
        (input.settlementToken ?? '0x0000000000000000000000000000000000000000') as Hex,
        {
          perTransferCapToken: input.tokenPolicy?.perTransferCapToken ?? 0n,
          windowCapToken: input.tokenPolicy?.windowCapToken ?? 0n,
        },
        input.accountSalt as Hex,
      ],
    }));
  }

  /**
   * SE-6: keccak256 of the deployed bytecode at `addr` (null = no code). Used by
   * `assertSameAddress` to prove factory/account BYTECODE identity across chains —
   * a colliding address with different bytecode is a spoof, refused.
   */
  async getCodeHash(addr: string): Promise<string | null> {
    const code = await this.publicClient.getCode({ address: addr as Hex });
    if (!code || code === '0x') return null;
    return keccak256(code);
  }

  /**
   * Revoke through the lane whose key IS the account's guardian (S7):
   * `accountGuardianAddr` = the guardian recorded at create (null/ops = legacy
   * Phase-1 lane). C-2: the receipt status is REQUIRED to be success — a
   * reverted guardian revoke must never be reported ok.
   */
  async revoke(accountAddr: string, accountGuardianAddr?: string | null): Promise<{ txHash: string }> {
    const useGuardianLane =
      typeof accountGuardianAddr === 'string' &&
      accountGuardianAddr.toLowerCase() === this.guardianAccount.address.toLowerCase();
    const wallet = useGuardianLane ? this.guardianWallet : this.opsWallet;
    const account = useGuardianLane ? this.guardianAccount : this.opsAccount;
    const serialize = useGuardianLane
      ? this.serializeGuardian.bind(this)
      : this.serializeOps.bind(this);
    return serialize(async () => {
      const hash = await wallet.writeContract({
        chain: wallet.chain,
        account,
        address: accountAddr as Hex,
        abi: leashAccountAbi,
        functionName: 'revoke',
      });
      const receipt = await waitReceipt(this.publicClient, hash);
      if (receipt.status !== 'success') {
        // C-2: surface the revert — callers must not mark the agent revoked.
        throw new Error(`guardian revoke tx reverted on-chain: ${hash}`);
      }
      return { txHash: hash };
    });
  }

  async fundSessionKey(addr: string, amountWei: bigint): Promise<{ txHash: string }> {
    return this.serializeOps(async () => {
      const hash = await this.opsWallet.sendTransaction({
        chain: this.opsWallet.chain,
        account: this.opsAccount,
        to: addr as Hex,
        value: amountWei,
      });
      await waitReceipt(this.publicClient, hash);
      return { txHash: hash };
    });
  }

  async getBalance(addr: string): Promise<bigint> {
    return this.publicClient.getBalance({ address: addr as Hex });
  }

  /** Live on-chain guardian of an account (M-03: resync after owner setGuardian). */
  async getGuardian(accountAddr: string): Promise<string> {
    const g = await this.publicClient.readContract({
      address: accountAddr as Hex,
      abi: leashAccountAbi,
      functionName: 'guardian',
    });
    return (g as string).toLowerCase();
  }

  async getPolicyView(accountAddr: string, allowlistCandidates: string[]): Promise<PolicyView> {
    return readPolicyView(this.publicClient, accountAddr, allowlistCandidates);
  }
}

/** Read the live on-chain policy for a LeashAccount (shared by ops + runtime). */
export async function readPolicyView(
  client: PublicClient,
  accountAddr: string,
  allowlistCandidates: string[],
): Promise<PolicyView> {
  const address = accountAddr as Hex;
  const [policy, revoked, spentInWindow, windowStart] = await Promise.all([
    client.readContract({ address, abi: leashAccountAbi, functionName: 'policy' }),
    client.readContract({ address, abi: leashAccountAbi, functionName: 'revoked' }),
    client.readContract({ address, abi: leashAccountAbi, functionName: 'spentInWindow' }),
    client.readContract({ address, abi: leashAccountAbi, functionName: 'windowStart' }),
  ]);
  const allowlist: string[] = [];
  for (const candidate of allowlistCandidates) {
    const allowed = await client.readContract({
      address,
      abi: leashAccountAbi,
      functionName: 'allowlist',
      args: [candidate as Hex],
    });
    if (allowed) allowlist.push(candidate.toLowerCase());
  }
  const base: PolicyView = {
    perTransferCap: policy[0],
    windowCap: policy[1],
    windowSeconds: policy[2],
    expiresAt: Number(policy[3]),
    allowlist,
    revoked,
    spentInWindow,
    windowStart: Number(windowStart),
  };
  // F9 mixed support: only v3 token-capable accounts expose these getters. A
  // v2 account has no `settlementToken` code — the read reverts, which we treat
  // as "native-only" (no token fields). We probe settlementToken first; a zero
  // (or a revert) means native-only.
  let settlementToken: string;
  try {
    settlementToken = (await client.readContract({
      address,
      abi: leashAccountAbi,
      functionName: 'settlementToken',
    }));
  } catch {
    return base; // legacy v2 account — no token surface
  }
  if (!settlementToken || /^0x0+$/i.test(settlementToken)) return base; // native-only v3
  const [tp, spentToken, windowStartToken] = await Promise.all([
    client.readContract({ address, abi: leashAccountAbi, functionName: 'tokenPolicy' }),
    client.readContract({ address, abi: leashAccountAbi, functionName: 'spentInWindowToken' }),
    client.readContract({ address, abi: leashAccountAbi, functionName: 'windowStartToken' }),
  ]);
  return {
    ...base,
    settlementToken: settlementToken.toLowerCase(),
    tokenPerTransferCap: tp[0],
    tokenWindowCap: tp[1],
    spentInWindowToken: spentToken,
    windowStartToken: Number(windowStartToken),
  };
}
