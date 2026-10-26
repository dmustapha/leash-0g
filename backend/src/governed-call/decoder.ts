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

  // AQ-FND M-4: CCIP ccipSend carries a dynamic EVM2AnyMessage — its own
  // strict-canonical decoder (the static machinery below cannot express it).
  if (spec.custom === 'ccip_send') return decodeCcipSend(spec, targetLc, value, hex);

  // Every registered signature is fully STATIC — exact length is 4 + 32*nParams.
  // SE-8 bridge shapes carry a trailing dynamic `bytes extraData` FORCED EMPTY:
  // exactly 2 extra words (canonical head offset + zero length).
  const expected = 4 + 32 * (spec.paramTypes.length + (spec.trailingEmptyBytes ? 2 : 0));
  if (bytes !== expected) {
    return base(targetLc, value, hex, spec.signature, `${spec.verb} on ${shortAddr(targetLc)} (bad length)`, {
      structured: spec.structured,
      amount: 0n,
      spendToken: spec.spendToken === 'target' ? targetLc : ZERO,
      recipients: [],
    }, 'DecodeMismatch');
  }

  const nWords = spec.paramTypes.length + (spec.trailingEmptyBytes ? 2 : 0);
  const words: string[] = [];
  for (let i = 0; i < nWords; i++) {
    words.push(hex.slice(10 + i * 64, 10 + (i + 1) * 64)); // 64 hex chars = 32 bytes
  }

  const args: AuthorityArgs = {
    structured: spec.structured,
    amount: 0n,
    spendToken: spec.spendToken === 'target' ? targetLc : ZERO,
    recipients: [],
  };
  let reject: DecodedCall['reject'];
  const decodedAddrs: (string | null)[] = [];

  // SE-8 bridge canonicality (mirrors the on-chain bridge decoders exactly):
  // the extraData head offset must be canonical and its length must be ZERO;
  // a payable bridge leg charges msg.value; a nonpayable one refuses any value.
  if (spec.trailingEmptyBytes) {
    const offWord = words[spec.paramTypes.length];
    const lenWord = words[spec.paramTypes.length + 1];
    const canonicalOffset = BigInt(32 * (spec.paramTypes.length + 1));
    if (
      offWord === undefined ||
      lenWord === undefined ||
      BigInt('0x' + offWord) !== canonicalOffset ||
      BigInt('0x' + lenWord) !== 0n
    ) {
      reject = 'DecodeMismatch';
    }
  }
  if (spec.forbidValue && value !== 0n) reject = 'DecodeMismatch';
  if (spec.valueIsAmount) args.amount = value;

  for (let i = 0; i < spec.paramTypes.length; i++) {
    const type = spec.paramTypes[i];
    const role = spec.roles[i];
    const word = words[i];
    if (type === undefined || role === undefined || word === undefined) continue;
    // AQ-FND M-4: pinned-zero words (CCTP destinationCaller) — any nonzero bit refuses.
    if (spec.zeroArgs?.includes(i) && BigInt('0x' + word) !== 0n) {
      reject = 'DecodeMismatch';
      break;
    }
    if (type === 'address' || (type === 'bytes32' && role === 'recipient')) {
      // bytes32 recipients (CCTP mintRecipient) use the SAME canonical encoding as an
      // address word — upper 96 bits zero — so the one decode covers both.
      const addr = decodeCanonicalAddress(word);
      decodedAddrs[i] = addr;
      if (addr === null) {
        reject = 'DecodeMismatch';
        break;
      }
      if (role === 'spender') args.spender = addr;
      else if (role === 'recipient') args.recipients.push(addr);
      else if (role === 'from') args.from = addr;
    } else if (type === 'bytes32') {
      // non-recipient bytes32 (destinationCaller): no decode — zeroArgs above pins it.
    } else if (type === 'uint32') {
      // strict canonical: bits above uint32 must be zero (contract mirrors).
      const raw = BigInt('0x' + word);
      if (raw >> 32n !== 0n) {
        reject = 'DecodeMismatch';
        break;
      }
      // AQ-FND M-4: extract the rail's far-chain domain for bridge-gate resolution.
      if (spec.bridgeDomainArg?.index === i) {
        args.bridgeDestination = { kind: spec.bridgeDomainArg.kind, value: raw.toString() };
      }
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

  // E-12 M-01: the ERC-20 bridge leg debits the LOCAL TOKEN's budget (arg 0),
  // mirroring the on-chain charge — never the unit-blind bridge key.
  if (spec.spendTokenFromArg !== undefined) {
    const tok = decodedAddrs[spec.spendTokenFromArg];
    if (tok) args.spendToken = tok;
  }
  return base(targetLc, value, hex, spec.signature, humanReadable(spec, targetLc, args), args, reject);
}

/**
 * AQ-FND M-4 — strict-canonical decode of CCIP `ccipSend(uint64, EVM2AnyMessage)`.
 *
 * ONE governable shape (anything else is DecodeMismatch, fail-closed):
 *   - exactly ONE tokenAmounts entry (the bridged token+amount — the budget key),
 *   - `data` EMPTY (no arbitrary far-chain payload rides a governed bridge leg),
 *   - `extraArgs` EMPTY (router defaults; no gas-limit smuggling),
 *   - `feeToken` = address(0): the fee is NATIVE, carried by msg.value — which the
 *     on-chain wall charges against the native budget and the rule's perCallCap,
 *   - `receiver` = a canonical 32-byte address word (→ recipient, pinned self by
 *     classify's bridge arm — funds land only on the same-address far account).
 *
 * Word layout (14 words, 452 bytes total):
 *   0 destinationChainSelector · 1 structOffset(0x40) · 2..6 struct head
 *   (receiverOff 0xa0 · dataOff 0xe0 · tokenAmountsOff 0x100 · feeToken · extraArgsOff 0x160)
 *   7 receiverLen(32) · 8 receiver · 9 dataLen(0) · 10 tokenAmountsLen(1)
 *   11 token · 12 amount · 13 extraArgsLen(0)
 */
function decodeCcipSend(spec: SelectorSpec, targetLc: string, value: bigint, hex: string): DecodedCall {
  const args: AuthorityArgs = { structured: false, amount: 0n, spendToken: ZERO, recipients: [] };
  const fail = (): DecodedCall =>
    base(targetLc, value, hex, spec.signature, `${spec.verb} via ${shortAddr(targetLc)} (non-canonical)`, args, 'DecodeMismatch');

  if (hexLen(hex) !== 4 + 32 * 14) return fail();
  const word = (i: number): bigint => BigInt('0x' + hex.slice(10 + i * 64, 10 + (i + 1) * 64));

  const chainSelector = word(0);
  if (chainSelector >> 64n !== 0n) return fail(); // canonical uint64
  const expect: Array<[number, bigint]> = [
    [1, 0x40n], // message struct offset
    [2, 0xa0n], // receiver offset (relative to struct)
    [3, 0xe0n], // data offset
    [4, 0x100n], // tokenAmounts offset
    [5, 0n], // feeToken = address(0) → native fee via msg.value
    [6, 0x160n], // extraArgs offset
    [7, 32n], // receiver length (one abi word)
    [9, 0n], // data EMPTY
    [10, 1n], // exactly ONE tokenAmount
    [13, 0n], // extraArgs EMPTY
  ];
  for (const [i, want] of expect) if (word(i) !== want) return fail();

  const receiverWord = hex.slice(10 + 8 * 64, 10 + 9 * 64);
  const receiver = decodeCanonicalAddress(receiverWord);
  const tokenWord = hex.slice(10 + 11 * 64, 10 + 12 * 64);
  const token = decodeCanonicalAddress(tokenWord);
  if (receiver === null || token === null) return fail();

  args.recipients.push(receiver);
  args.spendToken = token;
  args.amount = word(12);
  args.bridgeDestination = { kind: 'ccip_selector', value: chainSelector.toString() };
  return base(targetLc, value, hex, spec.signature, humanReadable(spec, targetLc, args), args);
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
