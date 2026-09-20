import { createPublicClient, createWalletClient, http, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { leashAccountAbi } from '../chain/abis.js';
import { readPolicyView, zeroGChain } from '../chain/ops.js';
import type { PolicyView } from '../types.js';

/**
 * The chain surface the agent runtime needs — reads plus ONE write:
 * LeashAccount.execute signed by the agent's scoped session key (never the
 * ops key, never owner authority). Injectable so runtime tests run without a
 * chain.
 */
export interface RuntimeChain {
  getBalance(addr: string): Promise<bigint>;
  getPolicyView(accountAddr: string, allowlistCandidates: string[]): Promise<PolicyView>;
  executeTransfer(input: {
    sessionPrivateKey: string;
    accountAddr: string;
    to: string;
    valueWei: bigint;
  }): Promise<{ txHash: string }>;
}

export class SessionChain implements RuntimeChain {
  private readonly publicClient: PublicClient;

  constructor(private readonly opts: { rpcUrl: string; chainId: number }) {
    this.publicClient = createPublicClient({
      chain: zeroGChain(opts.rpcUrl, opts.chainId),
      transport: http(opts.rpcUrl),
    });
  }

  async getBalance(addr: string): Promise<bigint> {
    return this.publicClient.getBalance({ address: addr as Hex });
  }

  async getPolicyView(accountAddr: string, allowlistCandidates: string[]): Promise<PolicyView> {
    return readPolicyView(this.publicClient, accountAddr, allowlistCandidates);
  }

  async executeTransfer(input: {
    sessionPrivateKey: string;
    accountAddr: string;
    to: string;
    valueWei: bigint;
  }): Promise<{ txHash: string }> {
    const account = privateKeyToAccount(input.sessionPrivateKey as Hex);
    const wallet = createWalletClient({
      chain: zeroGChain(this.opts.rpcUrl, this.opts.chainId),
      transport: http(this.opts.rpcUrl),
      account,
    });
    // Phase 1: native transfer only (contract requires data.length == 0)
    const txHash = await wallet.writeContract({
      chain: wallet.chain,
      account,
      address: input.accountAddr as Hex,
      abi: leashAccountAbi,
      functionName: 'execute',
      args: [input.to as Hex, input.valueWei, '0x'],
    });
    await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    return { txHash };
  }
}
