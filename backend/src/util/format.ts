/**
 * Human formatting for notification surfaces (00 §2c: plain language, never
 * raw wei). Shared by the digest renderer and the approval-card summaries.
 */

/** '2000000000000000' → '0.002 0G' (≤6 decimals, trailing zeros trimmed). */
export function formatG(wei: string, signed = false): string {
  const neg = wei.startsWith('-');
  const abs = neg ? wei.slice(1) : wei;
  const padded = abs.padStart(19, '0');
  const whole = padded.slice(0, -18).replace(/^0+(?=\d)/, '') || '0';
  const frac = padded.slice(-18).replace(/0+$/, '').slice(0, 6);
  const num = frac ? `${whole}.${frac}` : whole;
  return `${neg ? '-' : signed ? '+' : ''}${num} 0G`;
}

/** '0x9c9c…9c9c' — enough to recognize, short enough for a phone card. */
export function shortAddr(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

/** Milliseconds → 'in 10 min' / 'in 45 s' (approval-deadline copy). */
export function inMinutes(ms: number): string {
  if (ms < 90_000) return `in ${Math.max(1, Math.round(ms / 1000))} s`;
  return `in ${Math.round(ms / 60_000)} min`;
}
