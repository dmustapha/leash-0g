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
import { privateKeyToAccount } from 'viem/accounts';
import { factoryAbi, registryAbi, leashAccountAbi } from './abis.js';
import type { ChainOps } from '../server.js';
import type { PolicyView } from '../types.js';

export interface LeashChainOptions {
  rpcUrl: string;
  chainId: number;
  opsPrivateKey: string;
  factoryAddr: string;
  registryAddr: string;
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
 * On-chain operations signed by the LEASH ops key. The ops key is deployer +
 * guardian ONLY: it pays create gas and can revoke (refuse), but holds no
 * authority to move or govern user funds (non-custodial invariant, spec §6).
 * Ops transactions are serialized through a mutex to keep nonces ordered.
 */
export class LeashChainOps implements ChainOps {
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly account: Account;
  private txChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: LeashChainOptions) {
    const chain = zeroGChain(opts.rpcUrl, opts.chainId);
    this.account = privateKeyToAccount(opts.opsPrivateKey as Hex);
    this.publicClient = createPublicClient({ chain, transport: http(opts.rpcUrl) });
    this.walletClient = createWalletClient({ chain, transport: http(opts.rpcUrl), account: this.account });
  }

  get opsAddress(): string {
    return this.account.address;
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.txChain.then(fn, fn);
    this.txChain = next.catch(() => undefined);
    return next;
  }

  async deployAndRegister(input: Parameters<ChainOps['deployAndRegister']>[0]): ReturnType<ChainOps['deployAndRegister']> {
    return this.serialize(async () => {
      const createHash = await this.walletClient.writeContract({
        chain: this.walletClient.chain,
        account: this.account,
        address: this.opts.factoryAddr as Hex,
        abi: factoryAbi,
        functionName: 'createAccount',
        args: [
          input.ownerAddr as Hex,
          this.account.address, // guardian = ops key (revoke-only, S4)
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
      const createReceipt = await this.publicClient.waitForTransactionReceipt({ hash: createHash });
      const created = parseEventLogs({ abi: factoryAbi, logs: createReceipt.logs, eventName: 'AccountCreated' })[0];
      if (!created) throw new Error('factory createAccount emitted no AccountCreated event');
      const accountAddr = created.args.account;

      const auditPubKeyHex = (
        input.auditPubKey.startsWith('0x') ? input.auditPubKey : `0x${input.auditPubKey}`
      ) as Hex;
      const registerHash = await this.walletClient.writeContract({
        chain: this.walletClient.chain,
        account: this.account,
        address: this.opts.registryAddr as Hex,
        abi: registryAbi,
        functionName: 'register',
        args: [accountAddr, input.sessionKeyAddr as Hex, auditPubKeyHex, input.name],
      });
      const registerReceipt = await this.publicClient.waitForTransactionReceipt({ hash: registerHash });
      const registered = parseEventLogs({ abi: registryAbi, logs: registerReceipt.logs, eventName: 'AgentRegistered' })[0];
      if (!registered) throw new Error('registry register emitted no AgentRegistered event');

      return {
        accountAddr,
        chainAgentId: registered.args.agentId,
        createTx: createHash,
        registerTx: registerHash,
      };
    });
  }

  async revoke(accountAddr: string): Promise<{ txHash: string }> {
    return this.serialize(async () => {
      const hash = await this.walletClient.writeContract({
        chain: this.walletClient.chain,
        account: this.account,
        address: accountAddr as Hex,
        abi: leashAccountAbi,
        functionName: 'revoke',
      });
      await this.publicClient.waitForTransactionReceipt({ hash });
      return { txHash: hash };
    });
  }

  async fundSessionKey(addr: string, amountWei: bigint): Promise<{ txHash: string }> {
    return this.serialize(async () => {
      const hash = await this.walletClient.sendTransaction({
        chain: this.walletClient.chain,
        account: this.account,
        to: addr as Hex,
        value: amountWei,
      });
      await this.publicClient.waitForTransactionReceipt({ hash });
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
