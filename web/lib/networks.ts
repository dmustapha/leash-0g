// File: web/lib/networks.ts
// SE-7 multichain helpers: plain-language copy for every typed onboard refusal (spec §7.C —
// mirroring backend reasons EXACTLY, like leash-errors.ts does for account errors) and
// per-chain explorer links. NOTE: a "network" here is a BLOCKCHAIN (the /api/networks table),
// not an agent chain (/api/chains, the delegation graph).

import { config } from './config';
import type { OnboardRefusalReason } from './types';

/** Plain-language copy for the onboard POST's typed refusals — never a raw code in the UI. */
export const ONBOARD_REFUSAL_COPY: Record<OnboardRefusalReason, string> = {
  not_v4:
    'This agent runs an older account version that was not deployed deterministically — its address cannot be reproduced on other networks. Create a new agent to get a multichain-ready account.',
  no_persisted_tuple:
    'LEASH has no saved deployment recipe (account tuple) for this account, so it cannot reproduce the same address on another network.',
  home_chain: 'That is this agent’s home network — it already lives there.',
  already_onboarded: 'This agent is already on that network.',
  guardian_mismatch:
    'The guardian on record no longer matches the one this account was deployed with — onboarding refused to protect the same-address guarantee.',
  tuple_prediction_mismatch:
    'The persisted account tuple no longer predicts this account’s address — onboarding refused to protect the same-address guarantee.',
  mint_address_mismatch:
    'The account deployed on the new network did not land on the expected address — onboarding refused to protect the same-address guarantee.',
  unregistered_chain: 'That network is not registered with LEASH yet.',
  multichain_unavailable:
    'Multichain onboarding is temporarily unavailable — try again in a little while.',
};

/** Fallback when the backend sends a reason we do not know — still plain language. */
export const ONBOARD_REFUSAL_FALLBACK = 'Onboarding was refused. Nothing was changed.';

export function plainOnboardRefusal(reason: string | undefined): string {
  return reason !== undefined
    ? ((ONBOARD_REFUSAL_COPY as Record<string, string>)[reason] ?? ONBOARD_REFUSAL_FALLBACK)
    : ONBOARD_REFUSAL_FALLBACK;
}

/** Known tx-explorer prefixes by chainId. Chains without a known explorer show no link. */
const EXPLORER_TX_PREFIX: Record<number, string> = {
  [config.chainId]: 'https://chainscan-galileo.0g.ai/tx/', // 0G Galileo (home)
  84532: 'https://sepolia.basescan.org/tx/', // Base Sepolia
  11155111: 'https://sepolia.etherscan.io/tx/', // Ethereum Sepolia (bridge destination)
  421614: 'https://sepolia.arbiscan.io/tx/', // Arbitrum Sepolia (SE-9)
  46630: 'https://explorer.testnet.chain.robinhood.com/tx/', // Robinhood Chain testnet (Orbit L2)
};

/** Public RPC endpoint by chainId — used to build per-chain viem clients so owner-wallet
 *  writes land on the AGENT'S chain, never the platform default (F-11). Chains absent here
 *  fall back to the default-chain RPC (config.rpcUrl). Mirrors the backend's registered set. */
const RPC_URL: Record<number, string> = {
  [config.chainId]: config.rpcUrl, // 0G Galileo (home)
  84532: 'https://sepolia.base.org', // Base Sepolia
  11155111: 'https://ethereum-sepolia-rpc.publicnode.com', // Ethereum Sepolia
  421614: 'https://sepolia-rollup.arbitrum.io/rpc', // Arbitrum Sepolia
  46630: 'https://rpc.testnet.chain.robinhood.com', // Robinhood Chain testnet (Orbit L2)
};

export function rpcUrlFor(chainId: number | undefined): string {
  if (chainId === undefined) return config.rpcUrl;
  return RPC_URL[chainId] ?? config.rpcUrl;
}

/** Legible chain name without the /api/networks table (viem chain metadata + wallet add-chain). */
const CHAIN_DISPLAY_NAME: Record<number, string> = {
  [config.chainId]: '0G Galileo Testnet',
  84532: 'Base Sepolia',
  11155111: 'Ethereum Sepolia',
  421614: 'Arbitrum Sepolia',
  46630: 'Robinhood Chain testnet',
};

export function chainDisplayName(chainId: number): string {
  return CHAIN_DISPLAY_NAME[chainId] ?? `Chain ${chainId}`;
}

/** Native gas-token symbol by chainId — cockpit amounts are denominated in the agent's
 *  HOME chain currency, not the platform's. Every registered non-0G chain today is an
 *  ETH-gas testnet, so unknown chains fall back to ETH. */
const NATIVE_SYMBOL: Record<number, string> = {
  [config.chainId]: '0G', // 0G Galileo (home)
  84532: 'ETH', // Base Sepolia
  11155111: 'ETH', // Ethereum Sepolia
  421614: 'ETH', // Arbitrum Sepolia
  46630: 'ETH', // Robinhood Chain testnet (Orbit L2)
};

export function nativeSymbol(chainId: number | undefined): string {
  if (chainId === undefined) return '0G';
  return NATIVE_SYMBOL[chainId] ?? 'ETH';
}

/** Explorer link for a tx on `chainId`, or null when no explorer is known for that chain. */
export function networkTxUrl(chainId: number, txHash: string): string | null {
  const prefix = EXPLORER_TX_PREFIX[chainId];
  return prefix !== undefined ? `${prefix}${txHash}` : null;
}

/** Chain name from the registered-network table, with a legible fallback. */
export function chainName(chainId: number, networks: { chainId: number; name: string }[]): string {
  return networks.find((n) => n.chainId === chainId)?.name ?? `chain ${chainId}`;
}
