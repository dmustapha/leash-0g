import { encodeAbiParameters, type Hex } from 'viem';
import type { GrantState } from './types.js';
import { SELECTORS } from './selectors.js';
import { ruleKey } from './classify.js';

/**
 * The never-guess-money call-builder (Stage D, D-10). Given a MINIMAL model
 * intent — a granted `(target, selector)` and a proposed `amountWei` — it builds
 * the exact `executeCall(target, value, data)` calldata, filling EVERY authority
 * argument (spender / recipient / `from`) from SERVER-SIDE grant state, NEVER
 * from model text (`00 §6b` never-guess-money; brief §1 "authorization must never
 * read attacker-controllable input"). The model contributes ONLY: which granted
 * `(target, selector)` and the chargeable amount. Everything that moves value to
 * a party — the spender it approves, the recipient it pays — comes from the
 * owner-authored grant, so a hijacked/prompt-injected agent can never redirect a
 * recipient or approve a novel spender through this path.
 *
 * v1 supports the FULLY-AUTHORITY-DETERMINED selectors only — `approve`,
 * `transfer`, `transferFrom`, and ERC-4626 `deposit(assets, receiver)` — where
 * every non-amount arg is an authority arg the grant pins. A selector with a
 * free non-authority arg the grammar cannot resolve server-side (e.g. a router
 * `swap`'s `tokenOut`/`minOut`/`deadline`, or `setApprovalForAll`'s bool) is
 * `not_authority_determined`: the autonomous action stands down and such a call
 * is originated only via an owner JIT / `authorizeOnce` (a call the owner
 * reviewed), never fabricated from model reasoning. The result is re-classified
 * by `classifyIntendedCall` before submit, and the on-chain V4 wall is the sole
 * enforcement guarantee regardless.
 */

const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * SE-8: the server-side minGasLimit for a built OP-stack bridge leg. A NON-authority
 * arg (it can never move value to a party) resolved from this server constant so it
 * never originates from model text; 200k matches the OP-stack default relay budget.
 */
const BRIDGE_MIN_GAS_LIMIT = 200_000n;

export type BuildGovernedCallResult =
  | { ok: true; target: string; value: bigint; data: string }
  | {
      ok: false;
      reason: 'unknown_selector' | 'no_grant' | 'not_authority_determined' | 'bad_amount';
    };

export interface GovernedCallIntent {
  /** the granted contract the model chose (owner-allowlisted). */
  target: string;
  /** the granted 4-byte selector the model chose. */
  selector: string;
  /** the chargeable amount the model proposed, base-units decimal string. */
  amountWei: string;
}

/**
 * Build the calldata for a granted governed call, pinning authority args from
 * `grant`. Pure — reads only the passed grant-state mirror + the static selector
 * registry; never model text beyond `(target, selector, amount)`.
 *
 * @param self the account (LeashAccount) address — recipient/`from` pins resolve to it.
 */
export function buildGovernedCall(
  intent: GovernedCallIntent,
  grant: GrantState,
  self: string,
): BuildGovernedCallResult {
  const target = normHex(intent.target);
  const selector = normHex(intent.selector);
  const spec = SELECTORS.get(selector);
  if (!spec) return { ok: false, reason: 'unknown_selector' };

  // The grant is the sole source of authority args — no grant, nothing to build
  // from (a novel target/selector must go through JIT, never a synthesised call).
  const rule = grant.rules.get(ruleKey(target, selector));
  if (!rule) return { ok: false, reason: 'no_grant' };

  const amount = parseAmount(intent.amountWei);
  if (amount === null) return { ok: false, reason: 'bad_amount' };

  const selfLc = self.toLowerCase();
  // Resolve the single authority spender from the grant (approve/allowance shapes).
  // Ambiguity (0 or >1 granted spenders) is NOT resolvable without model text →
  // stand down (the owner narrows the grant, or approves a JIT for the exact call).
  const resolveSpender = (): string | null => {
    const only = rule.spenderSet.length === 1 ? rule.spenderSet[0] : undefined;
    return only ? only.toLowerCase() : null;
  };

  const words: { type: 'address' | 'uint256' | 'uint32' | 'bool' | 'bytes'; value: Hex | bigint | boolean }[] = [];
  for (let i = 0; i < spec.paramTypes.length; i++) {
    const type = spec.paramTypes[i];
    const role = spec.roles[i];
    if (type === undefined || role === undefined) return { ok: false, reason: 'not_authority_determined' };
    if (type === 'uint256' && role === 'amount') {
      words.push({ type, value: amount });
      continue;
    }
    if (type === 'uint32' && spec.bridge === true) {
      // bridge minGasLimit: non-authority, server-constant (never model text).
      words.push({ type, value: BRIDGE_MIN_GAS_LIMIT });
      continue;
    }
    if (type === 'address' && role === 'recipient') {
      // Recipient pins to self (the account is the receiver of its own swaps/
      // deposits/transfers). `allowlist` mode is not auto-resolvable (which of N
      // payees?) without model text → not determined. E-12 M-02: a BRIDGE
      // recipient is self UNCONDITIONALLY (the wall ignores rule mode there).
      if (spec.bridge !== true && rule.recipientMode !== 'self') {
        return { ok: false, reason: 'not_authority_determined' };
      }
      words.push({ type, value: selfLc as Hex });
      continue;
    }
    if (type === 'address' && role === 'from') {
      words.push({ type, value: selfLc as Hex }); // transferFrom(from) is always self (never a confused-deputy pull)
      continue;
    }
    if (type === 'address' && role === 'spender') {
      const spender = resolveSpender();
      if (spender === null) return { ok: false, reason: 'not_authority_determined' };
      words.push({ type, value: spender as Hex });
      continue;
    }
    // Any remaining arg is a non-authority free value the grammar cannot resolve
    // server-side (router route/minOut/deadline, an approvedBool, an ignored
    // uint) — refuse rather than let it originate from model text.
    return { ok: false, reason: 'not_authority_determined' };
  }

  // SE-8: a bridge signature ends in `bytes extraData` — always encoded EMPTY
  // (the wall reverts any non-empty tail; bridging never needs a payload).
  if (spec.trailingEmptyBytes) words.push({ type: 'bytes', value: '0x' });

  const data = encodeCall(selector, words);
  // The v1 selector set moves value via the amount arg (zero-value calls) EXCEPT
  // the payable bridge leg (`bridgeETHTo`), whose chargeable amount IS msg.value —
  // charged on-chain against the native budget.
  const value = spec.valueIsAmount ? amount : 0n;
  return { ok: true, target, value, data };
}

function encodeCall(
  selector: string,
  words: { type: 'address' | 'uint256' | 'uint32' | 'bool' | 'bytes'; value: Hex | bigint | boolean }[],
): string {
  const params = words.map((w) => ({ type: w.type }));
  const encoded = encodeAbiParameters(params, words.map((w) => w.value));
  return (selector + encoded.slice(2)).toLowerCase();
}

function normHex(s: string): string {
  return typeof s === 'string' && s.startsWith('0x') ? s.toLowerCase() : '';
}

function parseAmount(s: string): bigint | null {
  if (typeof s !== 'string' || !/^\d{1,40}$/.test(s)) return null;
  try {
    const v = BigInt(s);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

export { ZERO as ZERO_ADDRESS };
