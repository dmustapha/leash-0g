import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseEventLogs,
  type Chain,
  type PublicClient,
  type WalletClient,
  type Account,
  type Hex,
} from 'viem';
import { waitReceipt } from './wait-receipt.js';
import { privateKeyToAccount } from 'viem/accounts';
import { factoryAbi, registryAbi, leashAccountAbi } from './abis.js';
import type { ChainOps } from '../server.js';
import type { PolicyView } from '../types.js';

export interface LeashChainOptions {
  rpcUrl: string;
  chainId: number;
  opsPrivateKey: string;
  /** C-1: dedicated revoke-only guardian key — its own signer + nonce space. */
  guardianPrivateKey: string;
  factoryAddr: string;
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
      const createHash = await this.opsWallet.writeContract({
        chain: this.opsWallet.chain,
        account: this.opsAccount,
        address: this.opts.factoryAddr as Hex,
        abi: factoryAbi,
        functionName: 'createAccount',
        args: [
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
        ],
      });
      const createReceipt = await waitReceipt(this.publicClient, createHash);
      const created = parseEventLogs({ abi: factoryAbi, logs: createReceipt.logs, eventName: 'AccountCreated' })[0];
      if (!created) throw new Error('factory createAccount emitted no AccountCreated event');
      const accountAddr = created.args.account;

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
      };
    });
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
  const [policy, revoked] = await Promise.all([
    client.readContract({ address, abi: leashAccountAbi, functionName: 'policy' }),
    client.readContract({ address, abi: leashAccountAbi, functionName: 'revoked' }),
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
  return {
    perTransferCap: policy[0],
    windowCap: policy[1],
    windowSeconds: policy[2],
    expiresAt: Number(policy[3]),
    allowlist,
    revoked,
  };
}
