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
import { factoryAbi, factoryV4DeterministicAbi, registryAbi, leashAccountAbi } from './abis.js';
import type { ChainOps } from '../server.js';
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
        // SE-6 (security M-02): true when a pre-existing deterministic deploy at
        // the predicted address was adopted (no mint tx; createTx is the zero hash).
        adopted,
      };
    });
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
