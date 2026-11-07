/**
 * Beta step 3b: ONE exact amount formatter for every owner-facing number (digest text, trace summaries,
 * cockpit copy). Pure bigint math: no Number(), so no float noise at any size. `decimals === null`
 * (unreadable token) renders honestly as "<n> units" and never guesses a scale.
 */
const MAX_DP = 6;

export function formatAssetAmount(raw: bigint | string, decimals: number | null, symbol: string | null): string {
  const amount = typeof raw === 'bigint' ? raw : BigInt(raw);
  const label = symbol ?? 'units';
  if (decimals === null) return `${amount.toString()} units${symbol ? ` of ${symbol}` : ''}`;
  if (amount === 0n) return `0 ${label}`;
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const frac = (amount % scale).toString().padStart(decimals, '0');
  const shown = frac.slice(0, MAX_DP).replace(/0+$/, '');
  if (whole === 0n && shown === '') return `<0.${'0'.repeat(MAX_DP - 1)}1 ${label}`;
  return `${whole.toString()}${shown ? `.${shown}` : ''} ${label}`;
}

/** Native gas-coin symbol by chain (0G Galileo is 16602; every other registered chain is an ETH-gas L2/testnet). */
export function nativeSymbolOf(chainId: number): string {
  return chainId === 16602 ? '0G' : 'ETH';
}

/** One spend/balance bucket: `token === null` is the chain's native coin. */
export interface AssetBucket {
  chainId: number;
  token: string | null;
  symbol: string | null;
  decimals: number | null;
  amountWei: string;
}

export function formatBucket(b: AssetBucket): string {
  return b.token === null
    ? formatAssetAmount(b.amountWei, 18, nativeSymbolOf(b.chainId))
    : formatAssetAmount(b.amountWei, b.decimals, b.symbol ?? `${b.token.slice(0, 6)}…${b.token.slice(-4)}`);
}

/** "1.02 NOVL · <0.000001 0G", or "nothing" when every bucket is empty. */
export function formatBuckets(buckets: AssetBucket[]): string {
  const live = buckets.filter((b) => BigInt(b.amountWei) > 0n);
  return live.length ? live.map(formatBucket).join(' · ') : 'nothing';
}
