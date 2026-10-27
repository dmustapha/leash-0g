// File: web/lib/chain.ts
// 0G Galileo testnet (16602) chain definition + viem clients + LeashAccount owner ops.
// Owner on-chain writes (revoke fallback, policy changes, re-arm) are signed CLIENT-SIDE
// with the connected wallet; the backend never holds owner authority (00 §6b).

import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  encodeAbiParameters,
  encodePacked,
  http,
  keccak256,
  type Address,
  type Chain,
  type EIP1193Provider,
  type Hex,
} from 'viem';
import { config } from './config';
import { chainDisplayName, nativeSymbol, rpcUrlFor } from './networks';
import leashAccountAbi from './abi/LeashAccount.json';
import { LEASH_ACCOUNT_V4_ABI } from './abi/leashAccountV4';
import { accountAbiForVersion, LEASH_ACCOUNT_V5_SIGNING_ABI, type AccountVersion } from './abi/leashAccountV5';

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

// ─── F-11: per-chain clients ─────────────────────────────────────────────────
// Every owner write/read below accepts an optional trailing `chainId` and binds its
// clients to THAT chain (the agent's home chain), never silently to the platform
// default. Omitted chainId keeps the historical single-chain behavior byte-identical.

const chainCache = new Map<number, Chain>();

/** The viem chain object for a registered chainId (default chain when omitted). */
export function chainFor(chainId: number = config.chainId): Chain {
  if (chainId === config.chainId) return zeroGGalileo;
  let c = chainCache.get(chainId);
  if (c === undefined) {
    const symbol = nativeSymbol(chainId);
    c = defineChain({
      id: chainId,
      name: chainDisplayName(chainId),
      nativeCurrency: { name: symbol, symbol, decimals: 18 },
      rpcUrls: { default: { http: [rpcUrlFor(chainId)] } },
      testnet: true,
    });
    chainCache.set(chainId, c);
  }
  return c;
}

const publicClientCache = new Map<number, ReturnType<typeof createPublicClient>>();

export function publicClientFor(chainId: number = config.chainId) {
  if (chainId === config.chainId) return publicClient;
  let c = publicClientCache.get(chainId);
  if (c === undefined) {
    c = createPublicClient({ chain: chainFor(chainId), transport: http() });
    publicClientCache.set(chainId, c);
  }
  return c;
}

/** Ask the wallet to sit on `chainId` before an owner write: switch, adding the chain
 *  first when the wallet does not know it (EIP-3085/3326). No-op when already there. */
async function ensureWalletChain(provider: EIP1193Provider, chainId: number): Promise<void> {
  const hexId = `0x${chainId.toString(16)}`;
  const current = (await provider.request({ method: 'eth_chainId' })) as string;
  // Some embedded wallets return a DECIMAL chain-id string despite EIP-1193 — parse both.
  const currentId = current.startsWith('0x') ? parseInt(current, 16) : parseInt(current, 10);
  if (currentId === chainId) return;
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] });
  } catch (err) {
    if ((err as { code?: number }).code !== 4902) throw err;
    const c = chainFor(chainId);
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: hexId,
          chainName: c.name,
          rpcUrls: c.rpcUrls.default.http,
          nativeCurrency: c.nativeCurrency,
        },
      ],
    });
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] });
  }
}

export const LEASH_ACCOUNT_ABI = leashAccountAbi;

export type OnchainPolicy = {
  perTransferCap: bigint;
  windowCap: bigint;
  windowSeconds: number;
  expiresAt: bigint;
};

function walletClientFor(provider: EIP1193Provider, account: Address, chainId?: number) {
  return createWalletClient({ chain: chainFor(chainId), transport: custom(provider), account });
}

async function writeAccount(
  provider: EIP1193Provider,
  owner: Address,
  accountAddr: Address,
  functionName: string,
  args: readonly unknown[] = [],
  chainId?: number,
): Promise<Hex> {
  await ensureWalletChain(provider, chainId ?? config.chainId);
  const wallet = walletClientFor(provider, owner, chainId);
  const { request } = await publicClientFor(chainId).simulateContract({
    address: accountAddr,
    abi: LEASH_ACCOUNT_ABI,
    functionName,
    args: args as unknown[],
    account: owner,
  });
  return wallet.writeContract(request);
}

/** Owner-wallet direct revoke — the LEASH-independent escape hatch. */
export function revokeOnchain(provider: EIP1193Provider, owner: Address, account: Address, chainId?: number) {
  return writeAccount(provider, owner, account, 'revoke', [], chainId);
}

export function rearmOnchain(provider: EIP1193Provider, owner: Address, account: Address, chainId?: number) {
  return writeAccount(provider, owner, account, 'rearm', [], chainId);
}

/** Tightening is instant. */
export function tightenPolicyOnchain(
  provider: EIP1193Provider,
  owner: Address,
  account: Address,
  policy: OnchainPolicy,
  chainId?: number,
) {
  return writeAccount(provider, owner, account, 'tightenPolicy', [policy], chainId);
}

/** Loosening goes through the timelock queue; returns the propose tx. */
export function proposePolicyOnchain(
  provider: EIP1193Provider,
  owner: Address,
  account: Address,
  policy: OnchainPolicy,
  chainId?: number,
) {
  return writeAccount(provider, owner, account, 'proposePolicy', [policy], chainId);
}

/** Apply a queued (timelocked) change once its eta has passed. */
export function applyPolicyOnchain(provider: EIP1193Provider, owner: Address, account: Address, chainId?: number) {
  return writeAccount(provider, owner, account, 'applyPolicy', [], chainId);
}

export function applyAllowlistOnchain(provider: EIP1193Provider, owner: Address, account: Address, chainId?: number) {
  return writeAccount(provider, owner, account, 'applyAllowlist', [], chainId);
}

export function applyWithdrawOnchain(provider: EIP1193Provider, owner: Address, account: Address, chainId?: number) {
  return writeAccount(provider, owner, account, 'applyWithdraw', [], chainId);
}

async function readEta(account: Address, functionName: string, chainId?: number): Promise<bigint> {
  return (await publicClientFor(chainId).readContract({
    address: account,
    abi: LEASH_ACCOUNT_ABI,
    functionName,
  })) as bigint;
}

export function readPendingPolicyEta(account: Address, chainId?: number): Promise<bigint> {
  return readEta(account, 'pendingPolicyEta', chainId);
}

export function readPendingAllowlistEta(account: Address, chainId?: number): Promise<bigint> {
  return readEta(account, 'pendingAllowlistEta', chainId);
}

export function readPendingWithdrawEta(account: Address, chainId?: number): Promise<bigint> {
  return readEta(account, 'pendingWithdrawEta', chainId);
}

/** Unix-seconds etas for the three timelock queues; 0 = nothing pending. */
export type PendingEtas = { policy: number; allowlist: number; withdraw: number };

export async function readPendingEtas(account: Address, chainId?: number): Promise<PendingEtas> {
  const [policy, allowlist, withdraw] = await Promise.all([
    readPendingPolicyEta(account, chainId),
    readPendingAllowlistEta(account, chainId),
    readPendingWithdrawEta(account, chainId),
  ]);
  return { policy: Number(policy), allowlist: Number(allowlist), withdraw: Number(withdraw) };
}

/** Wait until a tx is mined (security-critical UI must not display unmined state). */
export async function waitForTx(hash: Hex, chainId?: number): Promise<void> {
  await publicClientFor(chainId).waitForTransactionReceipt({ hash });
}

/** Current guardian address on the account; the zero address means "no guardian". */
export async function readGuardian(account: Address, chainId?: number): Promise<Address> {
  return (await publicClientFor(chainId).readContract({
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
  chainId?: number,
) {
  return writeAccount(provider, owner, account, 'setGuardian', [newGuardian], chainId);
}

/** Plain native transfer from the owner wallet — used to fund the agent's account. */
export async function sendNativeOnchain(
  provider: EIP1193Provider,
  owner: Address,
  to: Address,
  valueWei: bigint,
  chainId?: number,
): Promise<Hex> {
  await ensureWalletChain(provider, chainId ?? config.chainId);
  const wallet = walletClientFor(provider, owner, chainId);
  return wallet.sendTransaction({ to, value: valueWei });
}

export function readAccountBalance(account: Address, chainId?: number): Promise<bigint> {
  return publicClientFor(chainId).getBalance({ address: account });
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

// RH2 (B1): the owner-arming helpers below encode the SHARED governed-calldata grammar
// (call rules, spend budget, price band) that LeashAccountV5 inherits byte-identically from
// V4. Threading the account's `version` lets a V5 account encode against the full V5 superset
// ABI while a V4/legacy account keeps the V4 ABI — additive, version-gated, no V4 behavior
// change (the shared selectors are identical, so this is correctness + unblocking V5-only
// accounts, not a V4 regression). `version` omitted ⇒ V4 (the historical default).
async function writeAccountVersioned(
  provider: EIP1193Provider,
  owner: Address,
  accountAddr: Address,
  functionName: string,
  args: readonly unknown[] = [],
  chainId?: number,
  version?: AccountVersion,
): Promise<Hex> {
  await ensureWalletChain(provider, chainId ?? config.chainId);
  const wallet = walletClientFor(provider, owner, chainId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const abi = (version === undefined ? V4_ABI_LOOSE : (accountAbiForVersion(version) as any));
  const { request } = await publicClientFor(chainId).simulateContract({
    address: accountAddr,
    abi,
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
  chainId?: number,
  version?: AccountVersion,
) {
  return writeAccountVersioned(provider, owner, account, 'proposeCallRule', [
    rule.target,
    rule.selector,
    recipientModeToUint(rule.recipientMode),
    rule.spenderSet,
    BigInt(rule.perCallCap),
    BigInt(rule.windowCapCall),
    rule.codehash ?? ZERO_CODEHASH,
  ], chainId, version);
}

/** Apply the single pending call-rule once its eta has passed. */
export function applyCallRuleOnchain(
  provider: EIP1193Provider,
  owner: Address,
  account: Address,
  chainId?: number,
  version?: AccountVersion,
) {
  return writeAccountVersioned(provider, owner, account, 'applyCallRule', [], chainId, version);
}

/** Tighten a (target,selector) rule's caps. INSTANT. */
export function tightenCallRuleOnchain(
  provider: EIP1193Provider,
  owner: Address,
  account: Address,
  args: { target: Address; selector: Hex; perCallCap: string; windowCapCall: string },
  chainId?: number,
  version?: AccountVersion,
) {
  return writeAccountVersioned(provider, owner, account, 'tightenCallRule', [
    args.target,
    args.selector,
    BigInt(args.perCallCap),
    BigInt(args.windowCapCall),
  ], chainId, version);
}

/** Remove one selector under a target. INSTANT. */
export function removeCallSelectorOnchain(
  provider: EIP1193Provider,
  owner: Address,
  account: Address,
  target: Address,
  selector: Hex,
  chainId?: number,
  version?: AccountVersion,
) {
  return writeAccountVersioned(provider, owner, account, 'removeCallSelector', [target, selector], chainId, version);
}

/** Remove an entire target (all its selectors). INSTANT. */
export function removeCallTargetOnchain(
  provider: EIP1193Provider,
  owner: Address,
  account: Address,
  target: Address,
  chainId?: number,
  version?: AccountVersion,
) {
  return writeAccountVersioned(provider, owner, account, 'removeCallTarget', [target], chainId, version);
}

/** One-shot JIT approve-once for a specific decoded call hash. INSTANT. */
export function authorizeOnceOnchain(
  provider: EIP1193Provider,
  owner: Address,
  account: Address,
  callHash: Hex,
  expiryUnixSec: number,
  chainId?: number,
  version?: AccountVersion,
) {
  return writeAccountVersioned(provider, owner, account, 'authorizeOnce', [callHash, BigInt(expiryUnixSec)], chainId, version);
}

// AQ-FND (⑥ live fix): V6 unified the per-token budget into the kinded governed pair —
// proposeGoverned(1, abi.encode(asset, AssetPolicy)) → applyGoverned with the SAME payload
// (on-chain commit check). The form's single "budget per window" maps to an enabled policy
// with perTransferCap == windowCap (one transfer may use the full window — the == case G-1
// explicitly allows) over the cockpit's standing 24h window.
const V6_GOVERNED_KIND_ASSET = 1;
const V6_BUDGET_WINDOW_SECONDS = 86400;
function v6BudgetPayload(token: Address, windowCap: string): Hex {
  const cap = BigInt(windowCap);
  return encodeAbiParameters(
    [
      { type: 'address' },
      {
        type: 'tuple',
        components: [
          { name: 'enabled', type: 'bool' },
          { name: 'perTransferCap', type: 'uint128' },
          { name: 'windowCap', type: 'uint128' },
          { name: 'windowSeconds', type: 'uint32' },
        ],
      },
    ],
    [token, { enabled: true, perTransferCap: cap, windowCap: cap, windowSeconds: V6_BUDGET_WINDOW_SECONDS }],
  );
}

/** Propose a per-token cumulative outflow budget. TIMELOCKED — apply after its eta. */
export function proposeSpendBudgetOnchain(
  provider: EIP1193Provider,
  owner: Address,
  account: Address,
  token: Address,
  windowCap: string,
  chainId?: number,
  version?: AccountVersion,
) {
  if (version === 6) {
    return writeAccountVersioned(
      provider, owner, account, 'proposeGoverned',
      [V6_GOVERNED_KIND_ASSET, v6BudgetPayload(token, windowCap)], chainId, version,
    );
  }
  return writeAccountVersioned(provider, owner, account, 'proposeSpendBudget', [token, BigInt(windowCap)], chainId, version);
}

/** FR4 (F-9): the band wall only ever governs the router's swap selector.
 *  Verify: `cast sig "swap(address,address,uint256,uint256,address,uint256)"` → 0x9908fc8b. */
export const BAND_SWAP_SELECTOR = '0x9908fc8b' as Hex;

/** Arm (or tighten) the price band on the canonical router's swap — INSTANT. */
export function tightenPriceBandOnchain(
  provider: EIP1193Provider,
  owner: Address,
  account: Address,
  band: { target: Address; feed: Address; asset: Address; maxDeviationBps: number; maxStalenessSec: number },
  chainId?: number,
  version?: AccountVersion,
) {
  return writeAccountVersioned(provider, owner, account, 'tightenPriceBand', [
    band.target,
    BAND_SWAP_SELECTOR,
    band.feed,
    band.asset,
    band.maxDeviationBps,
    BigInt(band.maxStalenessSec),
  ], chainId, version);
}

/** Latch band-required-for-every-swap — one-way owner opt-in (fail-closed). */
export function enableRequireBandForSwapOnchain(
  provider: EIP1193Provider,
  owner: Address,
  account: Address,
  chainId?: number,
  version?: AccountVersion,
) {
  return writeAccountVersioned(provider, owner, account, 'enableRequireBandForSwap', [], chainId, version);
}

/** FR4 (review fix): is a band ALREADY SET for router.swap on this account? Read on-chain
 *  so the two-step arm UI survives remounts (ruleKey = keccak256(target ++ selector)). */
export async function readPriceBandSet(account: Address, target: Address, chainId?: number): Promise<boolean> {
  const ruleKey = keccak256(encodePacked(['address', 'bytes4'], [target, BAND_SWAP_SELECTOR]));
  const r = (await publicClientFor(chainId).readContract({
    address: account,
    abi: LEASH_ACCOUNT_V4_ABI,
    functionName: 'priceBand',
    args: [ruleKey],
  })) as readonly unknown[];
  return Boolean(r[0]);
}

/** Live on-chain armed state — the panel shows THIS, never a cached mirror. */
export async function readRequireBandForSwap(account: Address, chainId?: number): Promise<boolean> {
  return (await publicClientFor(chainId).readContract({
    address: account,
    abi: LEASH_ACCOUNT_V4_ABI,
    functionName: 'requireBandForSwap',
  })) as boolean;
}

/** Apply the pending spend budget once its eta has passed. On V6 the apply must re-submit the
 *  SAME (token, windowCap) payload the propose committed to — the account checks the commit. */
export function applySpendBudgetOnchain(
  provider: EIP1193Provider,
  owner: Address,
  account: Address,
  token: Address,
  windowCap: string,
  chainId?: number,
  version?: AccountVersion,
) {
  if (version === 6) {
    return writeAccountVersioned(
      provider, owner, account, 'applyGoverned',
      [V6_GOVERNED_KIND_ASSET, v6BudgetPayload(token, windowCap)], chainId, version,
    );
  }
  return writeAccountVersioned(provider, owner, account, 'applySpendBudget', [], chainId, version);
}

/**
 * FR3 (F-8c, review fix): the account has ONE pending-rule slot and
 * `applyCallRule()` is argless — read the slot so the apply affordance can
 * verify it matches the row the owner clicked (a later proposal overwrites the
 * slot; applying blindly would activate the WRONG rule and corrupt the mirror).
 */
export async function readPendingCallRule(
  account: Address,
  chainId?: number,
): Promise<{ target: string; selector: string; eta: number }> {
  const r = (await publicClientFor(chainId).readContract({
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
export async function readPendingCallRuleEta(account: Address, chainId?: number): Promise<number> {
  const r = (await publicClientFor(chainId).readContract({
    address: account,
    abi: LEASH_ACCOUNT_V4_ABI,
    functionName: 'pendingCallRule',
  })) as readonly unknown[];
  return Number(r[6] as bigint);
}

/** Read the pending spend-budget eta (unix s); 0 = nothing pending. */
export async function readPendingBudgetEta(account: Address, chainId?: number): Promise<number> {
  return Number(
    (await publicClientFor(chainId).readContract({
      address: account,
      abi: LEASH_ACCOUNT_V4_ABI,
      functionName: 'pendingBudgetEta',
    })) as bigint,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase B2 (TA-ABI-5 close) — governed-SIGNING grants (LeashAccountV5 only).
// The owner arms a session-key signing authority through the SAME owner-signed,
// client-side, timelocked grammar as the V4 calldata grants: proposeSigningGrantNested
// is a LOOSEN (timelocked ~15 min) → applySigningGrant after the eta; tightenSigningGrant
// and removeSigningDescriptor are INSTANT restrictions. The on-chain V5 account is the
// sole enforcement wall; the read-model (`POST /signing/rule`) only mirrors these writes.
// These are NEW exported helpers — they never touch the V4 writeAccount path above.
// ─────────────────────────────────────────────────────────────────────────────

// The V5 signing fragments are heavily overloaded tuples; a dynamic functionName defeats
// viem's strict per-function arg inference, so we narrow to a loose abi at the call boundary
// (the human-readable signatures in leashAccountV5.ts stay the single source of truth).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V5_SIGNING_ABI_LOOSE = LEASH_ACCOUNT_V5_SIGNING_ABI as any;

async function writeAccountV5Signing(
  provider: EIP1193Provider,
  owner: Address,
  accountAddr: Address,
  functionName: string,
  args: readonly unknown[] = [],
  chainId?: number,
): Promise<Hex> {
  await ensureWalletChain(provider, chainId ?? config.chainId);
  const wallet = walletClientFor(provider, owner, chainId);
  const { request } = await publicClientFor(chainId).simulateContract({
    address: accountAddr,
    abi: V5_SIGNING_ABI_LOOSE,
    functionName,
    args: args as unknown[],
    account: owner,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return wallet.writeContract(request as any);
}

/** The on-chain grant parameters the backend `/signing/rule` returns (byte-exact to the
 *  wall's stored `proposeSigningGrantNested` struct). The owner signs the tx with exactly
 *  these — the backend computes them so the wall and the engine reconstruct identically. */
export type OnChainSigningGrant = {
  descriptorId: number;
  domainSeparator: Hex;
  typeHash: Hex;
  numFields: number;
  spenderIndex: number;
  amountIndex: number;
  deadlineIndex: number;
  nestedTypeHash: Hex;
  nestedLeafStart: number;
  nestedLeafCount: number;
  expiryLeafIndex: number;
  kind: number;
  buyToken: Hex;
  tokenCaps: { token: Hex; cap: string }[];
  tokenCapsHash: Hex;
};

/** The owner-authored per-descriptor budget the grant pins (scalar `token`/`perIntentCap`
 *  for flat/nested/order; the `spenders` allowlist; `caps` the batch per-token allowlist). */
export type SigningGrantInput = {
  grant: OnChainSigningGrant;
  spenders: Address[];
  /** Base-unit per-intent cap (ignored for batch, which uses `grant.tokenCaps`). */
  perIntentCap: string;
  /** Max deadline window seconds the armed intent may carry. */
  maxDeadlineWindow: number;
  /** Budget token (the pinned sell/spend token). */
  token: Address;
};

/**
 * Loosen: propose a governed-signing grant for one descriptor. TIMELOCKED — the owner
 * applies it after its eta. Encodes the backend-computed grant params into the V5
 * `proposeSigningGrantNested((...) p, address[] spenders, (address,uint128)[] caps)` tuple.
 */
export function proposeSigningGrantOnchain(
  provider: EIP1193Provider,
  owner: Address,
  account: Address,
  input: SigningGrantInput,
  chainId?: number,
) {
  const g = input.grant;
  const p = {
    descriptorId: BigInt(g.descriptorId),
    domainSeparator: g.domainSeparator,
    typeHash: g.typeHash,
    numTopFields: g.numFields,
    spenderLeafIndex: g.spenderIndex,
    amountLeafIndex: g.amountIndex,
    deadlineLeafIndex: g.deadlineIndex,
    expiryLeafIndex: g.expiryLeafIndex,
    nestedTypeHash: g.nestedTypeHash,
    nestedLeafStart: g.nestedLeafStart,
    nestedLeafCount: g.nestedLeafCount,
    token: input.token,
    perIntentCap: BigInt(input.perIntentCap),
    maxDeadlineWindow: BigInt(input.maxDeadlineWindow),
    kind: g.kind,
    buyToken: g.buyToken,
  };
  const caps = g.tokenCaps.map((c) => ({ token: c.token, cap: BigInt(c.cap) }));
  return writeAccountV5Signing(provider, owner, account, 'proposeSigningGrantNested', [
    p,
    input.spenders,
    caps,
  ], chainId);
}

/** Apply the single pending signing grant once its eta has passed. */
export function applySigningGrantOnchain(
  provider: EIP1193Provider,
  owner: Address,
  account: Address,
  chainId?: number,
) {
  return writeAccountV5Signing(provider, owner, account, 'applySigningGrant', [], chainId);
}

/** Tighten a descriptor's per-intent cap / deadline window. INSTANT. */
export function tightenSigningGrantOnchain(
  provider: EIP1193Provider,
  owner: Address,
  account: Address,
  args: { descriptorId: number; perIntentCap: string; maxDeadlineWindow: number },
  chainId?: number,
) {
  return writeAccountV5Signing(provider, owner, account, 'tightenSigningGrant', [
    BigInt(args.descriptorId),
    BigInt(args.perIntentCap),
    BigInt(args.maxDeadlineWindow),
  ], chainId);
}

/** Remove a signing descriptor entirely (bumps the signing epoch → stales its arms). INSTANT. */
export function removeSigningDescriptorOnchain(
  provider: EIP1193Provider,
  owner: Address,
  account: Address,
  descriptorId: number,
  chainId?: number,
) {
  return writeAccountV5Signing(provider, owner, account, 'removeSigningDescriptor', [
    BigInt(descriptorId),
  ], chainId);
}
