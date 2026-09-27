import { getAddress } from 'viem';
import type { AuthorityArgs, DecodedCall } from './types.js';
import { SELECTORS, SELECTOR_APPROVE, type SelectorSpec } from './selectors.js';
import { shortAddr } from '../util/format.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * Strict-canonical off-chain decode of one intended `executeCall` (target,value,data).
 *
 * It MIRRORS `LeashAccountV4._checkStructuredArgs` byte-for-byte for the structured
 * set — exact calldata length, zero upper bits on address words, canonical bool —
 * so a non-canonical encoding that the on-chain wall reverts with `DecodeMismatch`
 * is flagged `reject:'DecodeMismatch'` here too (H-04: the off-chain classify can
 * NEVER let a call the account would revert reach the chain as "in-envelope").
 *
 * Pure + total: never throws, never reads attacker-controllable global state.
 */
export function decodeCall(target: string, value: bigint, data: string): DecodedCall {
  const targetLc = normalizeAddr(target);
  const hex = typeof data === 'string' && data.startsWith('0x') ? data.toLowerCase() : '0x';
  const bytes = hexLen(hex);

  // data.length < 4 → DecodeMismatch (contract line 321).
  if (bytes < 4) {
    return base(targetLc, value, '0x00000000', null, `call ${shortAddr(targetLc)} (malformed calldata)`, {
      structured: false,
      amount: value,
      spendToken: ZERO,
      recipients: [],
    }, 'DecodeMismatch');
  }

  const selector = hex.slice(0, 10); // '0x' + 8 hex
  const spec = SELECTORS.get(selector);

  if (!spec) {
    // Unknown allowlisted selector: on-chain charges msg.value against the native
    // budget and relies on the off-chain gate for arg legibility (v1 decision (a)).
    return base(targetLc, value, hex, null, `call ${selector} on ${shortAddr(targetLc)}`, {
      structured: false,
      amount: value,
      spendToken: ZERO,
      recipients: [],
    });
  }

  // Every registered signature is fully STATIC — exact length is 4 + 32*nParams.
  const expected = 4 + 32 * spec.paramTypes.length;
  if (bytes !== expected) {
    return base(targetLc, value, hex, spec.signature, `${spec.verb} on ${shortAddr(targetLc)} (bad length)`, {
      structured: spec.structured,
      amount: 0n,
      spendToken: spec.spendToken === 'target' ? targetLc : ZERO,
      recipients: [],
    }, 'DecodeMismatch');
  }

  const words: string[] = [];
  for (let i = 0; i < spec.paramTypes.length; i++) {
    words.push(hex.slice(10 + i * 64, 10 + (i + 1) * 64)); // 64 hex chars = 32 bytes
  }

  const args: AuthorityArgs = {
    structured: spec.structured,
    amount: 0n,
    spendToken: spec.spendToken === 'target' ? targetLc : ZERO,
    recipients: [],
  };
  let reject: DecodedCall['reject'];

  for (let i = 0; i < spec.paramTypes.length; i++) {
    const type = spec.paramTypes[i];
    const role = spec.roles[i];
    const word = words[i];
    if (type === undefined || role === undefined || word === undefined) continue;
    if (type === 'address') {
      const addr = decodeCanonicalAddress(word);
      if (addr === null) {
        reject = 'DecodeMismatch';
        break;
      }
      if (role === 'spender') args.spender = addr;
      else if (role === 'recipient') args.recipients.push(addr);
      else if (role === 'from') args.from = addr;
    } else if (type === 'bool') {
      const raw = BigInt('0x' + word);
      if (raw > 1n) {
        reject = 'DecodeMismatch'; // non-canonical bool (contract line 461)
        break;
      }
      if (role === 'approvedBool') {
        args.approvedForAll = raw === 1n;
        if (raw === 1n) reject = 'BlanketApprovalForbidden'; // ban setApprovalForAll(_,true)
      }
    } else {
      // uint256
      const raw = BigInt('0x' + word);
      if (role === 'amount') args.amount = raw;
      if (spec.amountIndex === i && selector === SELECTOR_APPROVE && raw === MAX_UINT256) {
        args.infiniteApproval = true;
        reject = 'InfiniteApprovalForbidden'; // ban approve(max) (contract line 436)
      }
    }
  }

  return base(targetLc, value, hex, spec.signature, humanReadable(spec, targetLc, args), args, reject);
}

function base(
  target: string,
  value: bigint,
  data: string,
  signature: string | null,
  humanReadable: string,
  args: AuthorityArgs,
  reject?: DecodedCall['reject'],
): DecodedCall {
  const out: DecodedCall = { target, value, data, selector: data.slice(0, 10), signature, humanReadable, args };
  if (reject) out.reject = reject;
  return out;
}

/** Canonical address decode: upper 96 bits MUST be zero (contract `_decodeAddress`). */
function decodeCanonicalAddress(word: string): string | null {
  const raw = BigInt('0x' + word);
  if (raw >> 160n !== 0n) return null;
  const addr = '0x' + word.slice(24); // last 20 bytes
  return addr.toLowerCase();
}

function normalizeAddr(a: string): string {
  try {
    return getAddress(a).toLowerCase();
  } catch {
    return typeof a === 'string' ? a.toLowerCase() : '';
  }
}

function hexLen(hex: string): number {
  return Math.floor((hex.length - 2) / 2);
}

function humanReadable(spec: SelectorSpec, target: string, args: AuthorityArgs): string {
  const who = shortAddr(target);
  if (args.approvedForAll !== undefined) {
    return `${spec.verb} ${who} (approved=${args.approvedForAll})`;
  }
  const amt = args.amount > 0n ? ` ${args.amount.toString()} base-units` : '';
  const firstRecipient = args.recipients[0];
  const dest = firstRecipient ? ` → ${shortAddr(firstRecipient)}` : args.spender ? ` (spender ${shortAddr(args.spender)})` : '';
  return `${spec.verb}${amt} on ${who}${dest}`;
}
