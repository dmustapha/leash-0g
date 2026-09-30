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
};

/** Explorer link for a tx on `chainId`, or null when no explorer is known for that chain. */
export function networkTxUrl(chainId: number, txHash: string): string | null {
  const prefix = EXPLORER_TX_PREFIX[chainId];
  return prefix !== undefined ? `${prefix}${txHash}` : null;
}

/** Chain name from the registered-network table, with a legible fallback. */
export function chainName(chainId: number, networks: { chainId: number; name: string }[]): string {
  return networks.find((n) => n.chainId === chainId)?.name ?? `chain ${chainId}`;
}
