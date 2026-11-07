// Beta step 3b: owner-facing amounts speak the agent's ASSET (the same exact bigint formatter the
// backend uses for digest text and trace summaries — backend/src/asset/format.ts; keep them identical).
import { nativeSymbol } from './networks';
import type { AgentDigest, AssetBucket } from './types';

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

export function formatBucket(b: AssetBucket): string {
  return b.token === null
    ? formatAssetAmount(b.amountWei, 18, nativeSymbol(b.chainId))
    : formatAssetAmount(b.amountWei, b.decimals, b.symbol ?? `${b.token.slice(0, 6)}…${b.token.slice(-4)}`);
}

/** "1.02 NOVL · <0.000001 0G", or "nothing" when every bucket is empty. */
export function formatBuckets(buckets: AssetBucket[]): string {
  const live = buckets.filter((b) => BigInt(b.amountWei) > 0n);
  return live.length ? live.map(formatBucket).join(' · ') : 'nothing';
}

export type AgentMoney = {
  /** what it spent today, per asset ("1.02 NOVL"), or "0 0G"-style zero in its own asset */
  spent: string;
  /** the agent's own-asset balance ("3.98 NOVL") */
  balance: string;
  /** spent / balance in the agent's goal asset, for the headroom meter */
  spentWei: bigint;
  balanceWei: bigint;
};

/** The money an agent card shows: its GOAL asset for a token agent, the chain's native coin otherwise. */
export function agentMoney(d: AgentDigest | undefined, fallbackBalanceWei: string, chainId: number | undefined): AgentMoney {
  const cid = d?.chainId ?? chainId ?? 0;
  const goal = d?.goalAsset ?? null;
  if (goal) {
    const spent = (d?.spendByAsset ?? []).find((b) => b.token === goal.token);
    return {
      spent: spent ? formatBucket(spent) : formatAssetAmount(0n, goal.decimals, goal.symbol),
      balance: formatAssetAmount(goal.balanceWei, goal.decimals, goal.symbol),
      spentWei: BigInt(spent?.amountWei ?? '0'),
      balanceWei: BigInt(goal.balanceWei),
    };
  }
  const nat = (d?.spendByAsset ?? []).find((b) => b.token === null);
  const sym = nativeSymbol(cid || undefined);
  const balanceWei = d?.balanceWei ?? fallbackBalanceWei;
  return {
    spent: formatAssetAmount(nat?.amountWei ?? d?.spendWei ?? '0', 18, sym),
    balance: formatAssetAmount(balanceWei, 18, sym),
    spentWei: BigInt(nat?.amountWei ?? d?.spendWei ?? '0'),
    balanceWei: BigInt(balanceWei),
  };
}
