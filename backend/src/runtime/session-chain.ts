import { createPublicClient, createWalletClient, encodePacked, http, keccak256, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { leashAccountAbi, leashAccountV4Abi, erc20MetaAbi } from '../chain/abis.js';
import { readPolicyView, zeroGChain } from '../chain/ops.js';
import type { PolicyView } from '../types.js';
import { waitReceipt } from '../chain/wait-receipt.js';
import type { CallRule, GrantState } from '../governed-call/index.js';

/**
 * Stage D (D-10): the candidate set the runtime enumerates from the read-model to
 * live-read the AUTHORITATIVE on-chain grant state. The read-model tells us WHICH
 * (target,selector) + spenders + tokens to probe; the on-chain account tells us
 * what is ACTUALLY granted (allowed rules + spenders + per-token budgets). The
 * on-chain account is the sole authority — a read-model row that never applied
 * on-chain yields no rule here (so a not-yet-applied grant classifies novel → JIT,
 * never a doomed L1 submit).
 */
export interface GrantStateCandidates {
  accountAddr: string;
  rules: { target: string; selector: string; spenders: string[] }[];
  /** distinct token contracts to probe for a per-token cumulative budget (D-3). */
  tokens: string[];
}

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
  /**
   * Phase-4 governed ERC-20 settlement (F9): the contract builds the transfer
   * calldata — the agent supplies only (token, to, amount). A reverted settle
   * must never be recorded as a completed settlement.
   */
  executeTokenTransfer(input: {
    sessionPrivateKey: string;
    accountAddr: string;
    token: string;
    to: string;
    amountWei: bigint;
  }): Promise<{ txHash: string }>;
  /**
   * Stage D (D-10): the generic governed-call path. The agent's scoped session
   * key submits `executeCall(target, value, data)`; the on-chain V4 wall enforces
   * the grant + caps + decoders. The runtime NEVER submits an out-of-envelope
   * call (it routes novelty to JIT first, P3C-6) — a revert here is a genuine
   * boundary hit, never recorded as a completed action.
   */
  executeCall(input: {
    sessionPrivateKey: string;
    accountAddr: string;
    target: string;
    valueWei: bigint;
    data: string;
  }): Promise<{ txHash: string }>;
  /**
   * Read an ERC-20's symbol + decimals so the settlement surfaces can DETECT
   * and label the actual asset (native 0G vs USDC vs TestUSD …) instead of
   * assuming 0G. Read once per job at originate and stored on the job row.
   */
  getErc20Meta(token: string): Promise<{ symbol: string; decimals: number }>;
  /** FR3 (F-8): trader holdings sense — ERC-20 balance of an address. */
  getErc20Balance(token: string, owner: string): Promise<bigint>;
  /** FR3 (F-8): trader holdings sense — ERC-20 allowance owner→spender. */
  getErc20Allowance(token: string, owner: string, spender: string): Promise<bigint>;
  /**
   * Stage D (D-10): live-read the on-chain governed-call envelope for the given
   * candidates and build the authoritative `GrantState` the off-chain classify +
   * call-builder consult. The read-model has no per-token budget, so budgets are
   * ALWAYS read live here (never trusted from the mirror). Only ACTIVE on-chain
   * rules are returned; the account is the source of truth (live-chain-read).
   */
  readCallGrantState(candidates: GrantStateCandidates): Promise<GrantState>;
  /**
   * SE-2: live-read the on-chain one-shot authorization ETA for a callHash
   * (`oneShotAuthEta[callHash]`; 0 = none/consumed/expired-and-cleared). The
   * one-shot-consume path re-checks this at submit time (P3C-6 no-doomed-submit):
   * a revoked/expired/already-consumed one-shot returns 0 → stand down, never a
   * doomed submit. Optional so coordination-free test fakes need not implement it
   * (the on-chain wall is the ultimate guard regardless); prod SessionChain does.
   */
  readOneShotAuth?(accountAddr: string, callHash: string): Promise<bigint>;
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

  private readonly metaCache = new Map<string, { symbol: string; decimals: number }>();
  async getErc20Meta(token: string): Promise<{ symbol: string; decimals: number }> {
    const key = token.toLowerCase();
    const hit = this.metaCache.get(key);
    if (hit) return hit;
    const [decimals, symbol] = await Promise.all([
      this.publicClient.readContract({ address: token as Hex, abi: erc20MetaAbi, functionName: 'decimals' }),
      this.publicClient.readContract({ address: token as Hex, abi: erc20MetaAbi, functionName: 'symbol' }),
    ]);
    const meta = { symbol: String(symbol), decimals: Number(decimals) };
    this.metaCache.set(key, meta);
    return meta;
  }

  async getErc20Balance(token: string, owner: string): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: token as Hex,
      abi: erc20MetaAbi,
      functionName: 'balanceOf',
      args: [owner as Hex],
    })) as bigint;
  }

  async getErc20Allowance(token: string, owner: string, spender: string): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: token as Hex,
      abi: erc20MetaAbi,
      functionName: 'allowance',
      args: [owner as Hex, spender as Hex],
    })) as bigint;
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
    const receipt = await waitReceipt(this.publicClient, txHash);
    assertReceiptSuccess(receipt.status, txHash);
    return { txHash };
  }

  async executeTokenTransfer(input: {
    sessionPrivateKey: string;
    accountAddr: string;
    token: string;
    to: string;
    amountWei: bigint;
  }): Promise<{ txHash: string }> {
    const account = privateKeyToAccount(input.sessionPrivateKey as Hex);
    const wallet = createWalletClient({
      chain: zeroGChain(this.opts.rpcUrl, this.opts.chainId),
      transport: http(this.opts.rpcUrl),
      account,
    });
    // Phase 4: the contract builds IERC20.transfer(to, amount); the agent
    // supplies only (token, to, amount) — no raw calldata (D-JOB-6).
    const txHash = await wallet.writeContract({
      chain: wallet.chain,
      account,
      address: input.accountAddr as Hex,
      abi: leashAccountAbi,
      functionName: 'executeTokenTransfer',
      args: [input.token as Hex, input.to as Hex, input.amountWei],
    });
    const receipt = await waitReceipt(this.publicClient, txHash);
    assertReceiptSuccess(receipt.status, txHash);
    return { txHash };
  }

  async readCallGrantState(candidates: GrantStateCandidates): Promise<GrantState> {
    const account = candidates.accountAddr as Hex;
    const rules = new Map<string, CallRule>();
    const budgets = new Map<string, string>();

    await Promise.all([
      ...candidates.rules.map(async (c) => {
        const target = c.target.toLowerCase();
        const selector = c.selector.toLowerCase();
        const ruleKey = keccak256(encodePacked(['address', 'bytes4'], [target as Hex, selector as Hex]));
        const r = (await this.publicClient.readContract({
          address: account,
          abi: leashAccountV4Abi,
          functionName: 'callRules',
          args: [ruleKey],
        }));
        const [allowed, recipientMode, perCallCap, windowCapCall] = r;
        if (!allowed) return; // not active on-chain → no rule (classifies novel → JIT)
        // Which of the candidate spenders are ACTUALLY allowlisted on-chain.
        const spenderSet: string[] = [];
        await Promise.all(
          [...new Set(c.spenders.map((s) => s.toLowerCase()))].map(async (spender) => {
            const ok = (await this.publicClient.readContract({
              address: account,
              abi: leashAccountV4Abi,
              functionName: 'callRuleSpender',
              args: [ruleKey, spender as Hex],
            }));
            if (ok) spenderSet.push(spender);
          }),
        );
        rules.set(`${target}:${selector}`, {
          target,
          selector,
          recipientMode: recipientMode === 1 ? 'allowlist' : 'self',
          spenderSet,
          perCallCap: perCallCap.toString(),
          windowCapCall: windowCapCall.toString(),
        });
      }),
      ...[...new Set(candidates.tokens.map((t) => t.toLowerCase()))].map(async (token) => {
        const b = (await this.publicClient.readContract({
          address: account,
          abi: leashAccountV4Abi,
          functionName: 'spendBudget',
          args: [token as Hex],
        }));
        if (b[0]) budgets.set(token, b[1].toString()); // set → windowCap
      }),
    ]);

    // The recipient allowlist is not enumerable from the read-model; v1 pins
    // recipients to self (call-builder refuses allowlist-mode), so an empty set
    // is correct + fail-safe (an allowlist-mode recipient classifies novel → JIT).
    return { rules, budgets, allowlist: new Set<string>() };
  }

  async readOneShotAuth(accountAddr: string, callHash: string): Promise<bigint> {
    const eta = (await this.publicClient.readContract({
      address: accountAddr as Hex,
      abi: leashAccountV4Abi,
      functionName: 'oneShotAuthEta',
      args: [callHash as Hex],
    }));
    return BigInt(eta);
  }

  async executeCall(input: {
    sessionPrivateKey: string;
    accountAddr: string;
    target: string;
    valueWei: bigint;
    data: string;
  }): Promise<{ txHash: string }> {
    const account = privateKeyToAccount(input.sessionPrivateKey as Hex);
    const wallet = createWalletClient({
      chain: zeroGChain(this.opts.rpcUrl, this.opts.chainId),
      transport: http(this.opts.rpcUrl),
      account,
    });
    // Stage D: the agent supplies (target, value, data); the V4 account decodes
    // + enforces the grant. No raw arg authority ever originates off-chain.
    const txHash = await wallet.writeContract({
      chain: wallet.chain,
      account,
      address: input.accountAddr as Hex,
      abi: leashAccountV4Abi,
      functionName: 'executeCall',
      args: [input.target as Hex, input.valueWei, (input.data || '0x') as Hex],
    });
    const receipt = await waitReceipt(this.publicClient, txHash);
    assertReceiptSuccess(receipt.status, txHash);
    return { txHash };
  }
}

/** A reverted execute() must never be recorded as an acted transfer. */
export function assertReceiptSuccess(status: 'success' | 'reverted', txHash: string): void {
  if (status !== 'success') throw new Error(`execute transfer reverted on-chain: ${txHash}`);
}
