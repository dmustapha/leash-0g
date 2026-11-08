// File: web/lib/capabilities.ts
// Stage-D plain-language layer (00 §2c): the surface a normie reads. Jargon (selectors,
// addresses, codehash) stays behind Disclosure in the components; this maps the on-chain
// vocabulary to sentences a judge instantly gets.
import type { CapabilityRequestRow, Novelty, PresetKey } from './types';
import { shortAddr } from './format';

/** The 6 D-9 presets, plain-language name + one-line "what it lets the agent do". */
// `tag` is a terse mono sub-label (the design's .pt line) — an accurate one-line summary of
// each preset's real rule-kind, never marketing copy.
export const PRESET_CATALOG: { key: PresetKey; name: string; blurb: string; tag: string }[] = [
  { key: 'defi_trader', name: 'DeFi trader', tag: 'swap · liquidity', blurb: 'Swap and add liquidity on a fixed protocol, within a daily budget.' },
  { key: 'yield_manager', name: 'Yield manager', tag: 'vault deposit', blurb: 'Deposit into a set list of vaults. Lending, borrowing and withdrawals are not supported yet.' },
  { key: 'treasury_topper', name: 'Treasury topper', tag: 'transfer · self-only', blurb: 'Move funds only to your own wallets. Asks before any new recipient.' },
  { key: 'dca', name: 'DCA bot', tag: 'scheduled swap', blurb: 'One fixed swap route on a schedule. Asks before any change.' },
  { key: 'rebalancer', name: 'Portfolio rebalancer', tag: 'basket swaps', blurb: 'Swaps within a fixed basket, with turnover caps.' },
  { key: 'leverage_adv', name: 'Vault deposits (tighter)', tag: 'vault deposit', blurb: 'Deposits into a set list of vaults with smaller limits. Borrowing and repaying are not supported yet.' },
];

/** Why the agent had to ask — plain language, one line per novelty reason. */
export const NOVELTY_COPY: Record<Novelty, string> = {
  new_target: 'a contract it has never used before',
  new_selector: 'a kind of call it has never made before',
  over_cap: 'more than its per-call limit',
  over_budget: "a token with no budget set — you'd set one",
  new_spender: 'a new spender',
  new_recipient: 'a new recipient',
  bridge: 'a bridge',
  self_edit: 'editing its own permissions',
};

export function noveltyReason(n: Novelty): string {
  return NOVELTY_COPY[n] ?? 'something outside its standing permissions';
}

// ── SE-8: governed BRIDGE calls → human terms (FE-surface-parity §3c) ─────────
// The two structured OP-stack bridge selectors the wall hard-decodes (BR-2).
// We decode the SERVER-authored bytes (callValue/callData, bound by callHash) —
// never agent text — mirroring the backend decoder's strict word slicing. Any
// deviation from the canonical shape returns null and the card falls back to
// the server's humanReadable (unknown-selector behavior unchanged).

/** bridgeETHTo(address to, uint32 minGasLimit, bytes extraData) */
export const SELECTOR_BRIDGE_ETH_TO = '0xe11013dd';
/** bridgeERC20To(address localToken, address remoteToken, address to, uint256 amount, uint32 minGasLimit, bytes extraData) */
export const SELECTOR_BRIDGE_ERC20_TO = '0x540abf73';
// SE-9: the Arbitrum DIVERGENT bridge family (GatewayRouter + ArbSys). Same
// server-verified-bytes decode, divergent shapes (no remoteToken/minGas args).
/** outboundTransfer(address l1Token, address to, uint256 amount, bytes data) — Arbitrum ERC-20 */
export const SELECTOR_ARB_OUTBOUND_TRANSFER = '0x7b3a3c8b';
/** withdrawEth(address destination) — Arbitrum ETH (ArbSys) */
export const SELECTOR_ARB_WITHDRAW_ETH = '0x25e16063';

/** Canonical address word: upper 96 bits MUST be zero (mirrors the wall). */
function wordToAddress(word: string): string | null {
  if (!/^[0-9a-f]{64}$/.test(word) || !/^0{24}/.test(word)) return null;
  return '0x' + word.slice(24);
}

function words(data: string, n: number): string[] | null {
  const hex = data.toLowerCase();
  if (!hex.startsWith('0x') || hex.length !== 10 + n * 64) return null;
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(hex.slice(10 + i * 64, 10 + (i + 1) * 64));
  return out;
}

/** "to your same-address account" when the recipient is the agent's own account. */
function recipientPhrase(to: string, accountAddr?: string): string {
  return accountAddr && to.toLowerCase() === accountAddr.toLowerCase()
    ? 'to your same-address account'
    : `to ${shortAddr(to)}`;
}

/**
 * Human copy for a governed BRIDGE request, decoded from the server-verified
 * bytes. Returns null for non-bridge selectors or non-canonical calldata —
 * the caller falls back to decoded.humanReadable exactly as before.
 */
export function describeBridgeRequest(
  request: Pick<CapabilityRequestRow, 'decoded' | 'callValue' | 'callData'>,
  accountAddr?: string,
): string | null {
  const selector = request.decoded.selector.toLowerCase();
  const data = request.callData;
  const bridge = shortAddr(request.decoded.target);
  if (!data) return null;

  if (selector === SELECTOR_BRIDGE_ETH_TO) {
    // to, minGasLimit, extraData head offset, extraData length (forced empty).
    const w = words(data, 4);
    if (!w) return null;
    const to = wordToAddress(w[0]!);
    if (!to) return null;
    const value = request.callValue ?? request.decoded.value;
    return `bridge ${value} base-units via bridge ${bridge} ${recipientPhrase(to, accountAddr)} on the destination chain`;
  }

  if (selector === SELECTOR_BRIDGE_ERC20_TO) {
    // localToken, remoteToken, to, amount, minGasLimit, offset, length.
    const w = words(data, 7);
    if (!w) return null;
    const localToken = wordToAddress(w[0]!);
    const to = wordToAddress(w[2]!);
    if (!localToken || !to) return null;
    const amount = BigInt('0x' + w[3]!).toString();
    return `bridge ${amount} base-units of token ${shortAddr(localToken)} via bridge ${bridge} ${recipientPhrase(to, accountAddr)} on the destination chain`;
  }

  // SE-9 Arbitrum ERC-20: outboundTransfer(l1Token, to, amount, data). `l1Token`
  // (arg0) IS the remote token; recipient is arg1; data is forced empty (5 words).
  if (selector === SELECTOR_ARB_OUTBOUND_TRANSFER) {
    const w = words(data, 5);
    if (!w) return null;
    const l1Token = wordToAddress(w[0]!);
    const to = wordToAddress(w[1]!);
    if (!l1Token || !to) return null;
    const amount = BigInt('0x' + w[2]!).toString();
    return `bridge ${amount} base-units of token ${shortAddr(l1Token)} via Arbitrum gateway ${bridge} ${recipientPhrase(to, accountAddr)} on the destination chain`;
  }

  // SE-9 Arbitrum ETH: withdrawEth(destination) — single-arg, value = bridged amount.
  if (selector === SELECTOR_ARB_WITHDRAW_ETH) {
    const w = words(data, 1);
    if (!w) return null;
    const to = wordToAddress(w[0]!);
    if (!to) return null;
    const value = request.callValue ?? request.decoded.value;
    return `bridge ${value} base-units via Arbitrum ${bridge} ${recipientPhrase(to, accountAddr)} on the destination chain`;
  }

  return null;
}

/** Plain-language name for a recipient mode. */
export function recipientModeLabel(mode: 'self' | 'allowlist'): string {
  return mode === 'self' ? 'only your own account' : 'an allowlist you set';
}
