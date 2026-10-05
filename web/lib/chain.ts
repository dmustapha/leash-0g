// File: web/lib/chain.ts
// 0G Galileo testnet (16602) chain definition + viem clients + LeashAccount owner ops.
// Owner on-chain writes (revoke fallback, policy changes, re-arm) are signed CLIENT-SIDE
// with the connected wallet; the backend never holds owner authority (00 §6b).

import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  http,
  type Address,
  type EIP1193Provider,
  type Hex,
} from 'viem';
import { config } from './config';
import leashAccountAbi from './abi/LeashAccount.json';
import { LEASH_ACCOUNT_V4_ABI } from './abi/leashAccountV4';

export const zeroGGalileo = defineChain({
  id: config.chainId,
  name: '0G Galileo Testnet',
  nativeCurrency: { name: '0G', symbol: '0G', decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
  blockExplorers: {
    default: { name: 'Chainscan', url: 'https://chainscan-galileo.0g.ai' },
  },
  testnet: true,
});

export const publicClient = createPublicClient({ chain: zeroGGalileo, transport: http() });

export const LEASH_ACCOUNT_ABI = leashAccountAbi;

export type OnchainPolicy = {
  perTransferCap: bigint;
  windowCap: bigint;
  windowSeconds: number;
  expiresAt: bigint;
};

function walletClientFor(provider: EIP1193Provider, account: Address) {
  return createWalletClient({ chain: zeroGGalileo, transport: custom(provider), account });
}

async function writeAccount(
  provider: EIP1193Provider,
  owner: Address,
  accountAddr: Address,
  functionName: string,
  args: readonly unknown[] = [],
): Promise<Hex> {
  const wallet = walletClientFor(provider, owner);
  const { request } = await publicClient.simulateContract({
    address: accountAddr,
    abi: LEASH_ACCOUNT_ABI,
    functionName,
    args: args as unknown[],
    account: owner,
  });
  return wallet.writeContract(request);
}

/** Owner-wallet direct revoke — the LEASH-independent escape hatch. */
export function revokeOnchain(provider: EIP1193Provider, owner: Address, account: Address) {
  return writeAccount(provider, owner, account, 'revoke');
}

export function rearmOnchain(provider: EIP1193Provider, owner: Address, account: Address) {
  return writeAccount(provider, owner, account, 'rearm');
}

/** Tightening is instant. */
export function tightenPolicyOnchain(
  provider: EIP1193Provider,
  owner: Address,
  account: Address,
  policy: OnchainPolicy,
) {
  return writeAccount(provider, owner, account, 'tightenPolicy', [policy]);
}

/** Loosening goes through the timelock queue; returns the propose tx. */
export function proposePolicyOnchain(
  provider: EIP1193Provider,
  owner: Address,
  account: Address,
  policy: OnchainPolicy,
) {
  return writeAccount(provider, owner, account, 'proposePolicy', [policy]);
}

/** Apply a queued (timelocked) change once its eta has passed. */
export function applyPolicyOnchain(provider: EIP1193Provider, owner: Address, account: Address) {
  return writeAccount(provider, owner, account, 'applyPolicy');
}

export function applyAllowlistOnchain(provider: EIP1193Provider, owner: Address, account: Address) {
  return writeAccount(provider, owner, account, 'applyAllowlist');
}

export function applyWithdrawOnchain(provider: EIP1193Provider, owner: Address, account: Address) {
  return writeAccount(provider, owner, account, 'applyWithdraw');
}

async function readEta(account: Address, functionName: string): Promise<bigint> {
  return (await publicClient.readContract({
    address: account,
    abi: LEASH_ACCOUNT_ABI,
    functionName,
  })) as bigint;
}

export function readPendingPolicyEta(account: Address): Promise<bigint> {
  return readEta(account, 'pendingPolicyEta');
}

export function readPendingAllowlistEta(account: Address): Promise<bigint> {
  return readEta(account, 'pendingAllowlistEta');
}

export function readPendingWithdrawEta(account: Address): Promise<bigint> {
  return readEta(account, 'pendingWithdrawEta');
}

/** Unix-seconds etas for the three timelock queues; 0 = nothing pending. */
export type PendingEtas = { policy: number; allowlist: number; withdraw: number };

export async function readPendingEtas(account: Address): Promise<PendingEtas> {
  const [policy, allowlist, withdraw] = await Promise.all([
    readPendingPolicyEta(account),
    readPendingAllowlistEta(account),
    readPendingWithdrawEta(account),
  ]);
  return { policy: Number(policy), allowlist: Number(allowlist), withdraw: Number(withdraw) };
}

/** Wait until a tx is mined (security-critical UI must not display unmined state). */
export async function waitForTx(hash: Hex): Promise<void> {
  await publicClient.waitForTransactionReceipt({ hash });
}

/** Current guardian address on the account; the zero address means "no guardian". */
export async function readGuardian(account: Address): Promise<Address> {
  return (await publicClient.readContract({
    address: account,
    abi: LEASH_ACCOUNT_ABI,
    functionName: 'guardian',
  })) as Address;
}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

/** Owner-wallet setGuardian tx. Pass ZERO_ADDRESS to remove the guardian entirely —
 *  the escape hatch: after that, only the owner wallet can revoke. */
export function setGuardianOnchain(
  provider: EIP1193Provider,
  owner: Address,
  account: Address,
  newGuardian: Address,
) {
  return writeAccount(provider, owner, account, 'setGuardian', [newGuardian]);
}

/** Plain native transfer from the owner wallet — used to fund the agent's account. */
export async function sendNativeOnchain(
  provider: EIP1193Provider,
  owner: Address,
  to: Address,
  valueWei: bigint,
): Promise<Hex> {
  const wallet = walletClientFor(provider, owner);
  return wallet.sendTransaction({ to, value: valueWei });
}

export function readAccountBalance(account: Address): Promise<bigint> {
  return publicClient.getBalance({ address: account });
}

export function txUrl(hash: Hex): string {
  return `https://chainscan-galileo.0g.ai/tx/${hash}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage D — governed-calldata capability grants (LeashAccountV4).
// Owner-signed, client-side, mirroring writeAccount(): loosen paths (proposeCallRule,
// proposeSpendBudget) are TIMELOCKED (~15 min) → applyCallRule/applySpendBudget after eta;
// tighten/remove/authorizeOnce are INSTANT. The on-chain V4 account is the sole enforcement
// wall; the read-model only ever mirrors what these writes do.
// ─────────────────────────────────────────────────────────────────────────────

/** No-codehash-pin sentinel (v1): the contract treats 32 zero bytes as "no pin". */
export const ZERO_CODEHASH = ('0x' + '0'.repeat(64)) as Hex;

/** recipientMode enum: 0 = self (recipient must equal the account), 1 = allowlist. */
export type RecipientMode = 'self' | 'allowlist';
export function recipientModeToUint(mode: RecipientMode): 0 | 1 {
  return mode === 'allowlist' ? 1 : 0;
}

// The V4 grammar has many overloadable owner writes; a dynamic functionName defeats viem's
// strict per-function arg inference. We narrow to a loose abi type at the call boundary — the
// human-readable signatures above stay the single source of truth (byte-exact to the backend).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V4_ABI_LOOSE = LEASH_ACCOUNT_V4_ABI as any;

async function writeAccountV4(
  provider: EIP1193Provider,
  owner: Address,
  accountAddr: Address,
  functionName: string,
  args: readonly unknown[] = [],
): Promise<Hex> {
  const wallet = walletClientFor(provider, owner);
  const { request } = await publicClient.simulateContract({
    address: accountAddr,
    abi: V4_ABI_LOOSE,
    functionName,
    args: args as unknown[],
    account: owner,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return wallet.writeContract(request as any);
}

/** A governed-call rule the owner grants (loosen/tighten). Amounts are base-units strings. */
export type CallRuleInput = {
  target: Address;
  selector: Hex; // 0x + 8 hex (bytes4)
  recipientMode: RecipientMode;
  spenderSet: Address[];
  perCallCap: string; // base units
  windowCapCall: string; // base units
  codehash?: Hex; // defaults to ZERO_CODEHASH (no pin) in v1
};

/** Loosen: add or widen a (target,selector) rule. TIMELOCKED — apply after its eta. */
export function proposeCallRuleOnchain(
  provider: EIP1193Provider,
  owner: Address,
  account: Address,
  rule: CallRuleInput,
) {
  return writeAccountV4(provider, owner, account, 'proposeCallRule', [
    rule.target,
    rule.selector,
    recipientModeToUint(rule.recipientMode),
    rule.spenderSet,
    BigInt(rule.perCallCap),
    BigInt(rule.windowCapCall),
    rule.codehash ?? ZERO_CODEHASH,
  ]);
}

/** Apply the single pending call-rule once its eta has passed. */
export function applyCallRuleOnchain(provider: EIP1193Provider, owner: Address, account: Address) {
  return writeAccountV4(provider, owner, account, 'applyCallRule');
}

/** Tighten a (target,selector) rule's caps. INSTANT. */
export function tightenCallRuleOnchain(
  provider: EIP1193Provider,
  owner: Address,
  account: Address,
  args: { target: Address; selector: Hex; perCallCap: string; windowCapCall: string },
) {
  return writeAccountV4(provider, owner, account, 'tightenCallRule', [
    args.target,
    args.selector,
    BigInt(args.perCallCap),
    BigInt(args.windowCapCall),
  ]);
}

/** Remove one selector under a target. INSTANT. */
export function removeCallSelectorOnchain(
  provider: EIP1193Provider,
  owner: Address,
  account: Address,
  target: Address,
  selector: Hex,
) {
  return writeAccountV4(provider, owner, account, 'removeCallSelector', [target, selector]);
}

/** Remove an entire target (all its selectors). INSTANT. */
export function removeCallTargetOnchain(
  provider: EIP1193Provider,
  owner: Address,
  account: Address,
  target: Address,
) {
  return writeAccountV4(provider, owner, account, 'removeCallTarget', [target]);
}

/** One-shot JIT approve-once for a specific decoded call hash. INSTANT. */
export function authorizeOnceOnchain(
  provider: EIP1193Provider,
  owner: Address,
  account: Address,
  callHash: Hex,
  expiryUnixSec: number,
) {
  return writeAccountV4(provider, owner, account, 'authorizeOnce', [callHash, BigInt(expiryUnixSec)]);
}

/** Propose a per-token cumulative outflow budget. TIMELOCKED — apply after its eta. */
export function proposeSpendBudgetOnchain(
  provider: EIP1193Provider,
  owner: Address,
  account: Address,
  token: Address,
  windowCap: string,
) {
  return writeAccountV4(provider, owner, account, 'proposeSpendBudget', [token, BigInt(windowCap)]);
}

/** Apply the pending spend budget once its eta has passed. */
export function applySpendBudgetOnchain(provider: EIP1193Provider, owner: Address, account: Address) {
  return writeAccountV4(provider, owner, account, 'applySpendBudget');
}

/**
 * FR3 (F-8c, review fix): the account has ONE pending-rule slot and
 * `applyCallRule()` is argless — read the slot so the apply affordance can
 * verify it matches the row the owner clicked (a later proposal overwrites the
 * slot; applying blindly would activate the WRONG rule and corrupt the mirror).
 */
export async function readPendingCallRule(
  account: Address,
): Promise<{ target: string; selector: string; eta: number }> {
  const r = (await publicClient.readContract({
    address: account,
    abi: LEASH_ACCOUNT_V4_ABI,
    functionName: 'pendingCallRule',
  })) as readonly unknown[];
  return {
    target: String(r[0]).toLowerCase(),
    selector: String(r[1]).toLowerCase(),
    eta: Number(r[6] as bigint),
  };
}

/** Read the pending call-rule eta (unix s); 0 = nothing pending. */
export async function readPendingCallRuleEta(account: Address): Promise<number> {
  const r = (await publicClient.readContract({
    address: account,
    abi: LEASH_ACCOUNT_V4_ABI,
    functionName: 'pendingCallRule',
  })) as readonly unknown[];
  return Number(r[6] as bigint);
}

/** Read the pending spend-budget eta (unix s); 0 = nothing pending. */
export async function readPendingBudgetEta(account: Address): Promise<number> {
  return Number(
    (await publicClient.readContract({
      address: account,
      abi: LEASH_ACCOUNT_V4_ABI,
      functionName: 'pendingBudgetEta',
    })) as bigint,
  );
}
