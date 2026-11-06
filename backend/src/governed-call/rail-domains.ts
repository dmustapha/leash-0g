/**
 * AQ-FND M-4 — multi-domain rail destination resolution (D-5: CCTP for the
 * Base/Eth/Arb USDC legs, Chainlink CCIP for every 0G leg).
 *
 * CCTP's TokenMessenger and CCIP's Router each serve MANY destination chains from
 * ONE contract address, so the SE-8 one-target→one-destination `bridgeDestinations`
 * config map cannot name their far leg. The destination is instead DECODED from the
 * call (CCTP `destinationDomain` uint32; CCIP `destinationChainSelector` uint64) and
 * resolved here against PROTOCOL CONSTANTS — Circle's domain ids and Chainlink's
 * chain selectors are fixed by those protocols, not operator config. An unknown
 * domain/selector resolves to null and the bridge-gate REFUSES (default-deny): a
 * rail leg whose far chain we cannot verify same-address is never routable.
 *
 * TESTNET-ONLY tables (LEASH is testnet-only, spec §4). The CCIP selectors were
 * probed live on-chain 2026-10-26 (`evidence/aq-fnd/ccip-probe-results.json`);
 * the CCTP domains are Circle's published v2 ids (verified live by the step-0
 * probe on all three Sepolias).
 */

/** Circle CCTP v2 domain id → EVM chain id (testnet). */
export const CCTP_DOMAIN_TO_CHAIN: ReadonlyMap<number, number> = new Map([
  [0, 11155111], // Ethereum Sepolia
  [3, 421614], // Arbitrum Sepolia
  [6, 84532], // Base Sepolia
]);

/** Chainlink CCIP chain selector (decimal string — uint64) → EVM chain id (testnet). */
export const CCIP_SELECTOR_TO_CHAIN: ReadonlyMap<string, number> = new Map([
  ['6892437333620424805', 16602], // 0G Galileo Testnet
  ['10344971235874465080', 84532], // Base Sepolia (lane from 0G is mainnet-gated — kept for the reverse legs)
  ['16015286601757825753', 11155111], // Ethereum Sepolia
  ['3478487238524512106', 421614], // Arbitrum Sepolia
]);

/**
 * Resolve a decoded rail destination to its chain id, or null (→ the bridge-gate
 * refuses `unknown_rail_domain`, never guesses).
 */
export function resolveRailDestination(dest: { kind: 'cctp_domain' | 'ccip_selector'; value: string }): number | null {
  if (dest.kind === 'cctp_domain') {
    if (!/^\d{1,10}$/.test(dest.value)) return null;
    return CCTP_DOMAIN_TO_CHAIN.get(Number(dest.value)) ?? null;
  }
  if (!/^\d{1,20}$/.test(dest.value)) return null;
  return CCIP_SELECTOR_TO_CHAIN.get(dest.value) ?? null;
}

/** Inverse of CCTP_DOMAIN_TO_CHAIN: the Circle domain id of an EVM chain, or null. */
export function cctpDomainOfChain(chainId: number): number | null {
  for (const [domain, chain] of CCTP_DOMAIN_TO_CHAIN) if (chain === chainId) return domain;
  return null;
}
