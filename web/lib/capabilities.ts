// File: web/lib/capabilities.ts
// Stage-D plain-language layer (00 §2c): the surface a normie reads. Jargon (selectors,
// addresses, codehash) stays behind Disclosure in the components; this maps the on-chain
// vocabulary to sentences a judge instantly gets.
import type { Novelty, PresetKey } from './types';

/** The 6 D-9 presets, plain-language name + one-line "what it lets the agent do". */
export const PRESET_CATALOG: { key: PresetKey; name: string; blurb: string }[] = [
  { key: 'defi_trader', name: 'DeFi trader', blurb: 'Swap and add liquidity on a fixed protocol, within a daily budget.' },
  { key: 'yield_manager', name: 'Yield manager', blurb: 'Supply and withdraw to a set list of vaults. No borrowing.' },
  { key: 'treasury_topper', name: 'Treasury topper', blurb: 'Move funds only to your own wallets. Asks before any new recipient.' },
  { key: 'dca', name: 'DCA bot', blurb: 'One fixed swap route on a schedule. Asks before any change.' },
  { key: 'rebalancer', name: 'Portfolio rebalancer', blurb: 'Swaps within a fixed basket, with turnover caps.' },
  { key: 'leverage_adv', name: 'Leverage manager', blurb: 'Risk-lowering actions only — supply and repay. Borrowing always asks.' },
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

/** Plain-language name for a recipient mode. */
export function recipientModeLabel(mode: 'self' | 'allowlist'): string {
  return mode === 'self' ? 'only your own account' : 'an allowlist you set';
}
