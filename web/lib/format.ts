// File: web/lib/format.ts
// Human units for 0G native value (18 decimals) and time. Plain-language surface (00 §2c).

import { formatEther, parseEther } from 'viem';

/** "0.01" 0G → wei string. Throws on invalid input. */
export function ogToWei(og: string): string {
  return parseEther(og.trim()).toString();
}

/** wei string → trimmed 0G display, e.g. "0.01". */
export function weiToOg(wei: string | bigint): string {
  const s = formatEther(typeof wei === 'bigint' ? wei : BigInt(wei));
  return s.replace(/\.?0+$/, '') || '0';
}

export function isValidOgAmount(v: string): boolean {
  if (!/^\d+(\.\d+)?$/.test(v.trim())) return false;
  try {
    return parseEther(v.trim()) > 0n;
  } catch {
    return false;
  }
}

export function shortAddr(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

/** Seconds until `ts` (unix s) as a friendly countdown, e.g. "2h 05m". */
export function countdown(untilUnixSec: number, nowMs = Date.now()): string {
  let s = Math.floor(untilUnixSec - nowMs / 1000);
  if (s <= 0) return 'expired';
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(s - m * 60).padStart(2, '0')}s`;
}
