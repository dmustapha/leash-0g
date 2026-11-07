import type { DecodedCall } from '../governed-call/types.js';
import { shortAddr } from '../util/format.js';
import { formatAssetAmount, nativeSymbolOf } from './format.js';

/**
 * Beta step 3b (S-3): the owner-facing sentence for a decoded governed call. The decoder's own text is
 * pure and chain-blind ("approve 1000000 base-units on 0x036c…cf7e (spender 0x94cc…2bc4)"); this adds
 * the two things only the chain knows: the token's symbol/decimals and the names of well-known
 * contracts. Anything it cannot say honestly falls back to the decoder text (never a guess).
 */
export interface CallLabeler {
  /** symbol/decimals of an ERC-20, or null when unreadable. */
  tokenMeta(token: string): Promise<{ symbol: string; decimals: number } | null>;
  /** a well-known contract's plain name ("Uniswap router", "Circle bridge"), or null. */
  nameOf(addr: string): string | null;
}

export async function describeDecodedCall(d: DecodedCall, chainId: number, labeler: CallLabeler): Promise<string> {
  const a = d.args;
  if (a.approvedForAll !== undefined || a.amount <= 0n) return d.humanReadable;
  const verb = d.humanReadable.split(' ')[0] ?? '';
  const isToken = a.structured && !/^0x0+$/.test(a.spendToken);
  let amount: string;
  if (isToken) {
    const meta = await labeler.tokenMeta(a.spendToken).catch(() => null);
    amount = formatAssetAmount(a.amount, meta?.decimals ?? null, meta?.symbol ?? labeler.nameOf(a.spendToken) ?? shortAddr(a.spendToken));
  } else {
    amount = formatAssetAmount(a.amount, 18, nativeSymbolOf(chainId));
  }
  const name = (addr: string): string => labeler.nameOf(addr) ?? shortAddr(addr);
  if (a.spender) return `${verb} ${amount} for ${name(a.spender)}`;
  const recipient = a.recipients[0];
  if (recipient) return `${verb} ${amount} to ${name(recipient)}`;
  return `${verb} ${amount} on ${name(d.target)}`;
}
