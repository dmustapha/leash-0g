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
