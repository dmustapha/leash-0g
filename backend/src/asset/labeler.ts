import type { CallLabeler } from './describe-call.js';

/**
 * Beta step 3b: the ONE place that decides how an address is named for the owner — the chain's
 * well-known contracts by plain name, ERC-20s by their on-chain symbol. Shared by the live ask
 * (runtime manager) and the read-time re-description of asks that were stored before this existed.
 */
export interface LabelerChain {
  getErc20Meta?(token: string): Promise<{ symbol: string; decimals: number }>;
}
export interface LabelerConfig {
  canonical?: { router?: string | undefined } | undefined;
  cctpTokenMessenger?: string | undefined;
}

export function makeCallLabeler(ops: LabelerChain | null, cfg: LabelerConfig | null): CallLabeler & {
  /** the plain name for an address: a known contract, "<SYM> token" for an ERC-20, else null. */
  nameFor(addr: string): Promise<{ name: string | null; symbol: string | null; decimals: number | null }>;
} {
  const names = new Map<string, string>();
  if (cfg?.canonical?.router) names.set(cfg.canonical.router.toLowerCase(), 'the DEX router');
  if (cfg?.cctpTokenMessenger) names.set(cfg.cctpTokenMessenger.toLowerCase(), 'the Circle bridge');
  const tokenMeta = async (t: string) => (ops?.getErc20Meta ? ops.getErc20Meta(t).catch(() => null) : null);
  return {
    tokenMeta,
    nameOf: (a) => names.get(a.toLowerCase()) ?? null,
    async nameFor(addr) {
      const known = names.get(addr.toLowerCase()) ?? null;
      if (known) return { name: known, symbol: null, decimals: null };
      const meta = await tokenMeta(addr);
      return meta ? { name: `${meta.symbol} token`, symbol: meta.symbol, decimals: meta.decimals } : { name: null, symbol: null, decimals: null };
    },
  };
}
