import { createPublicClient, createWalletClient, encodePacked, http, keccak256, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { aggregatorV3Abi, leashAccountAbi, leashAccountV4Abi, leashAccountV5SigningAbi, leashAccountV6PolicyAbi, erc20MetaAbi } from '../chain/abis.js';
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
  getPolicyView(accountAddr: string, allowlistCandidates: string[], assetCandidates?: string[]): Promise<PolicyView>;
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
   *
   * `onSubmitted` fires with the hash the instant the tx is BROADCAST, before
   * the receipt is waited on. It exists because the wait can throw for a tx
   * that landed, and this is the only moment at which the hash is knowable but
   * not yet at risk — a caller that moves value must persist it here or it can
   * pay and have no record of having paid.
   */
  executeTokenTransfer(input: {
    sessionPrivateKey: string;
    accountAddr: string;
    token: string;
    to: string;
    amountWei: bigint;
    onSubmitted?: (txHash: string) => Promise<void>;
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
   * FR3b: the account's live band-feed price for a (target, selector) swap rule,
   * 18dp — or null when no band is set / the feed is unreadable. The runtime
   * derives the swap's minOut from THIS server-read on-chain value (never model
   * text), so an armed band sees implied price == oracle (dead-center in-band);
   * the wall's own staleness/deviation predicates remain the enforcement.
   */
  getSwapBandPrice18(accountAddr: string, target: string, selector: string): Promise<bigint | null>;
  /**
   * AQ-FND M-3: is a token SPENDABLE from this V6 account toward the given payees?
   * Reads `assetPolicy(token).enabled` and, for each payee candidate,
   * `allowlist(token, payee)` — both LIVE on-chain (the account is the sole
   * authority). The gas ladder's spendable-token filter (D-4) and the novel-token
   * one-ask hinge (D-1) consult this, never model text. Optional so coordination-
   * free test fakes need not implement it (absent ⇒ treated as not-spendable →
   * ask-owner, fail-closed); prod SessionChain does.
   */
  getAssetPolicy?(
    accountAddr: string,
    token: string,
    payeeCandidates: string[],
  ): Promise<{ enabled: boolean; allowedPayees: string[] }>;
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
  /**
   * Stage F′ FP-3: the governed-signing ARM. The scoped session key signs the EIP-712 `digest`
   * (raw ECDSA — the contract `ECDSA.recover(digest, sig)`s it) and submits the ordered leaf words
   * via `authorizeSigningIntent`. The on-chain V5 wall reconstructs the digest from the fields,
   * re-checks the descriptor policy (spender ∈ set · nested amount ≤ cap · deadline/expiry bounds),
   * DEBITS the shared per-token budget, and arms the digest for `isValidSignature`. A revert is a
   * genuine boundary hit (never recorded as an armed intent). Returns the armed digest + the epoch
   * snapshot the read-model records. Optional so coordination-free fakes need not implement it.
   */
  authorizeSigningIntent?(input: {
    sessionPrivateKey: string;
    accountAddr: string;
    descriptorId: number;
    fields: string[];
    digest: string;
    /**
     * FP-4 Slice-2 (`07 #15`): the co-signer's second-factor approval bytes, when the account has an
     * active co-signer. Defaults to empty (`0x`) — the INERT path (`coSigner == address(0)`), which is
     * every account today. Who holds the co-signer key + the approval-fetch orchestration is DEFERRED to
     * the `#16` mainnet-legal slice (D-FP4-2e); until then no account sets a co-signer, so `0x` always arms.
     */
    coSignerSig?: string;
    /**
     * FP-4 Slice-5: the reviewed per-token cap allowlist submitted at arm for a `kind==batch` intent (the
     * wall verifies `keccak256(abi.encode(caps)) == policy.tokenCapsHash`). EMPTY for standard/order — and
     * every runtime path today arms via `buildIntent` (non-batch), so this defaults to `[]`.
     */
    caps?: { token: string; cap: string }[];
  }): Promise<{ txHash: string; digest: string; epoch: number }>;
  /**
   * A SINGLE receipt probe — no waiting, no retry. The settlement sweep's only
   * chain question: "has the network made up its mind about this hash yet?"
   *   'success' | 'reverted' → terminal, the sweep writes the outcome
   *   'pending'              → not indexed yet, ask again next tick
   * It is deliberately NOT `waitReceipt`: a sweep that blocks 3 minutes per row
   * would serialise the whole work set behind the slowest unknown tx, and the
   * tick IS the retry loop. Optional so coordination-free fakes need not
   * implement it; prod SessionChain does.
   */
  getReceiptStatus?(txHash: string): Promise<'success' | 'reverted' | 'pending'>;
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

  async getPolicyView(accountAddr: string, allowlistCandidates: string[], assetCandidates: string[] = []): Promise<PolicyView> {
    return readPolicyView(this.publicClient, accountAddr, allowlistCandidates, assetCandidates);
  }

  async getReceiptStatus(txHash: string): Promise<'success' | 'reverted' | 'pending'> {
    try {
      const r = await this.publicClient.getTransactionReceipt({ hash: txHash as Hex });
      return r.status === 'success' ? 'success' : 'reverted';
    } catch {
      // Any read failure is 'pending', not 'failed'. On 0G an unindexed receipt
      // and an RPC hiccup are indistinguishable from here, and the only safe
      // default for a tx that may have moved value is "still don't know".
      return 'pending';
    }
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
    return this.publicClient.readContract({
      address: token as Hex,
      abi: erc20MetaAbi,
      functionName: 'balanceOf',
      args: [owner as Hex],
    });
  }

  async getErc20Allowance(token: string, owner: string, spender: string): Promise<bigint> {
    return this.publicClient.readContract({
      address: token as Hex,
      abi: erc20MetaAbi,
      functionName: 'allowance',
      args: [owner as Hex, spender as Hex],
    });
  }

  async getSwapBandPrice18(accountAddr: string, target: string, selector: string): Promise<bigint | null> {
    // bytes4 is unforgiving: a short/odd selector would be silently right-padded
    // into a WRONG ruleKey (band invisible → minOut 1 → armed band reverts).
    if (!/^0x[0-9a-fA-F]{8}$/.test(selector) || !/^0x[0-9a-fA-F]{40}$/.test(target)) return null;
    try {
      // on-chain ruleKey = keccak256(abi.encodePacked(target, selector)).
      const key = keccak256(encodePacked(['address', 'bytes4'], [target.toLowerCase() as Hex, selector.toLowerCase() as Hex]));
      const band = await this.publicClient.readContract({
        address: accountAddr as Hex,
        abi: leashAccountV4Abi,
        functionName: 'priceBand',
        args: [key],
      });
      if (!band[0]) return null;
      const [, answer] = await this.publicClient.readContract({
        address: band[1],
        abi: aggregatorV3Abi,
        functionName: 'latestRoundData',
      });
      if (answer <= 0n) return null;
      return answer * 10n ** 10n; // 8dp oracle → 18dp
    } catch (err) {
      // No band / legacy account / feed unreadable — minOut falls back to 1 and
      // the on-chain wall (if any) remains the enforcement guarantee. Logged so a
      // misconfigured account/feed is visible in service logs without killing the cycle.
      console.warn(`band price read failed for ${accountAddr} ${target}:${selector}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  async getAssetPolicy(
    accountAddr: string,
    token: string,
    payeeCandidates: string[],
  ): Promise<{ enabled: boolean; allowedPayees: string[] }> {
    const asset = token.toLowerCase() as Hex;
    const policy = await this.publicClient.readContract({
      address: accountAddr as Hex,
      abi: leashAccountV6PolicyAbi,
      functionName: 'assetPolicy',
      args: [asset],
    });
    const enabled = policy[0];
    const uniquePayees = [...new Set(payeeCandidates.map((p) => p.toLowerCase()))];
    const allowedPayees: string[] = [];
    await Promise.all(
      uniquePayees.map(async (payee) => {
        const ok = await this.publicClient.readContract({
          address: accountAddr as Hex,
          abi: leashAccountV6PolicyAbi,
          functionName: 'allowlist',
          args: [asset, payee as Hex],
        });
        if (ok) allowedPayees.push(payee);
      }),
    );
    return { enabled, allowedPayees };
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
    onSubmitted?: (txHash: string) => Promise<void>;
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
    // Write-ahead, and NOT swallowed: if the caller cannot persist the hash we
    // must not proceed into a wait that can lose it. Throwing here is the safe
    // direction — the tx is already broadcast either way, but a loud failure at
    // this point is diagnosable, whereas a silent one reproduces the bug.
    if (input.onSubmitted) await input.onSubmitted(txHash);
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

  async authorizeSigningIntent(input: {
    sessionPrivateKey: string;
    accountAddr: string;
    descriptorId: number;
    fields: string[];
    digest: string;
    coSignerSig?: string;
    caps?: { token: string; cap: string }[];
  }): Promise<{ txHash: string; digest: string; epoch: number }> {
    const account = privateKeyToAccount(input.sessionPrivateKey as Hex);
    // RAW ECDSA over the EIP-712 digest (the contract does `ECDSA.recover(digest, sig)` — no
    // eth-prefix). viem `account.sign({ hash })` is exactly that raw signature.
    const sessionSig = await account.sign({ hash: input.digest as Hex });
    const wallet = createWalletClient({
      chain: zeroGChain(this.opts.rpcUrl, this.opts.chainId),
      transport: http(this.opts.rpcUrl),
      account,
    });
    const txHash = await wallet.writeContract({
      chain: wallet.chain,
      account,
      address: input.accountAddr as Hex,
      abi: leashAccountV5SigningAbi,
      functionName: 'authorizeSigningIntent',
      // FP-4 Slice-5: `caps` is the reviewed TokenCap[] for a batch arm; EMPTY for standard/order (every
      // runtime path today arms a non-batch intent). coSignerSig defaults to empty (`0x`) — the inert path;
      // every account today has no co-signer (identity + approval orchestration deferred to `#16`, D-FP4-2e).
      args: [
        BigInt(input.descriptorId),
        input.fields as Hex[],
        (input.caps ?? []).map((c) => ({ token: c.token as Hex, cap: BigInt(c.cap) })),
        sessionSig,
        (input.coSignerSig ?? '0x') as Hex,
      ],
    });
    const receipt = await waitReceipt(this.publicClient, txHash);
    assertReceiptSuccess(receipt.status, txHash);
    // the epoch snapshot the read-model records (FP-CARRY-5 staleness keys off it).
    const epoch = await this.publicClient.readContract({
      address: input.accountAddr as Hex,
      abi: leashAccountV5SigningAbi,
      functionName: 'signingEpoch',
    });
    return { txHash, digest: input.digest, epoch: Number(epoch) };
  }
}

/** A reverted execute() must never be recorded as an acted transfer. */
export function assertReceiptSuccess(status: 'success' | 'reverted', txHash: string): void {
  if (status !== 'success') throw new Error(`execute transfer reverted on-chain: ${txHash}`);
}
