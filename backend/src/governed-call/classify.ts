import type { Classification, DecodedCall, GrantState, Novelty } from './types.js';
import { BRIDGE_SELECTORS, SELF_EDIT_SELECTORS } from './selectors.js';

const ZERO = '0x0000000000000000000000000000000000000000';

/** `${target}:${selector}`, both lowercased. */
export function ruleKey(target: string, selector: string): string {
  return `${target.toLowerCase()}:${selector.toLowerCase()}`;
}

/**
 * Classify an intended call against the on-chain envelope (the three-lane model,
 * `07 S28`). PURE — reads only the passed grant-state mirror (never model text /
 * memory / on-chain history, brief §1). The runtime uses this to route
 * in-envelope → act (L1 silent), novel → JIT (L2, not a doomed submit, P3C-6),
 * forbidden → block. It is fail-closed: any structural defect the on-chain wall
 * would revert on (a `decoded.reject`) is `forbidden`, never surfaced as L1.
 *
 * @param self the account (LeashAccount) address — recipient `self`-pins compare to it.
 */
export function classify(decoded: DecodedCall, grant: GrantState, self: string): Classification {
  const selfLc = self.toLowerCase();

  // Structural defects the account reverts on (H-04 / bans) — fail-closed, never L1/L2-as-safe.
  if (decoded.reject === 'DecodeMismatch') return { lane: 'forbidden', reason: 'decode_mismatch' };
  if (decoded.reject === 'InfiniteApprovalForbidden') return { lane: 'forbidden', reason: 'infinite_approval' };
  if (decoded.reject === 'BlanketApprovalForbidden') return { lane: 'forbidden', reason: 'blanket_approval' };

  // No self-call (the account can never call itself — self_call revert).
  if (decoded.target.toLowerCase() === selfLc) return { lane: 'forbidden', reason: 'self_call' };

  // Confused-deputy: transferFrom(from) must ALWAYS be self, in any mode — spending
  // someone else's funds is never legitimate and is never JIT-grantable.
  if (decoded.args.from !== undefined && decoded.args.from.toLowerCase() !== selfLc) {
    return { lane: 'forbidden', reason: 'from_not_self' };
  }

  // SE-8 (BR-2, carry #2 — the bridge allowlist is ENFORCED here, never dormant):
  // a structured bridge selector may ONLY target a bridge in the chain's
  // owner-configured bridge allowlist; and a call to a bridge-allowlisted target
  // with any OTHER selector is default-DENIED (no structured decoder for that
  // bridge selector = not governable — never falls through to the non-structured
  // msg.value lane where an ERC-20 bridge amount would ride uncharged).
  const selectorLc = decoded.selector.toLowerCase();
  const isBridgeSelector = BRIDGE_SELECTORS.has(selectorLc);
  const bridgeTargets = grant.bridgeTargets ?? new Set<string>();
  const targetIsBridge = bridgeTargets.has(decoded.target.toLowerCase());
  if (isBridgeSelector && !targetIsBridge) {
    return { lane: 'forbidden', reason: 'bridge_not_allowlisted' };
  }
  if (targetIsBridge && !isBridgeSelector) {
    return { lane: 'forbidden', reason: 'bridge_undecodable' };
  }

  // AQ-FND M-3 inc-3a: a swap-to-gas call may only BUY the chain's wrapped-native. Fail-closed:
  // a decoded output token outside the pinned set is never JIT-grantable as a gas swap.
  if (
    decoded.args.swapTokenOut !== undefined &&
    grant.swapOutputTokens !== undefined &&
    !grant.swapOutputTokens.has(decoded.args.swapTokenOut.toLowerCase())
  ) {
    return { lane: 'forbidden', reason: 'swap_output_not_allowed' };
  }

  const key = ruleKey(decoded.target, decoded.selector);
  const rule = grant.rules.get(key);
  const novelty: Novelty[] = [];

  // self-edit deny (M-01): editing own authority always asks, even if somehow granted.
  if (SELF_EDIT_SELECTORS.has(decoded.selector.toLowerCase())) novelty.push('self_edit');

  if (!rule) {
    // Is the TARGET known at all, or is this a brand-new contract?
    let targetHasAnyRule = false;
    for (const k of grant.rules.keys()) {
      if (k.startsWith(decoded.target.toLowerCase() + ':')) {
        targetHasAnyRule = true;
        break;
      }
    }
    novelty.push(targetHasAnyRule ? 'new_selector' : 'new_target');
    return { lane: 'l2', novelty: dedupe(novelty) };
  }

  // spender novelty (approve/increaseAllowance/setApprovalForAll): a new spender always asks.
  if (decoded.args.spender !== undefined) {
    const set = new Set(rule.spenderSet.map((s) => s.toLowerCase()));
    if (!set.has(decoded.args.spender.toLowerCase())) novelty.push('new_spender');
  }

  // recipient novelty: an unsatisfied recipient pin → ask to add it (never a silent redirect).
  // E-12 M-02 mirror: a BRIDGE recipient must be SELF regardless of rule mode — the
  // on-chain wall pins it unconditionally, so a mode-1 bridge redirect must never
  // classify in-envelope (it would be a doomed submit).
  for (const r of decoded.args.recipients) {
    const rl = r.toLowerCase();
    const satisfied =
      isBridgeSelector || rule.recipientMode === 'self' ? rl === selfLc : grant.allowlist.has(rl);
    if (!satisfied) novelty.push('new_recipient');
  }

  // over per-call cap → ask (cumulative caps are enforced on-chain; per-call is statically checkable).
  if (decoded.args.amount > 0n) {
    const cap = safeBig(rule.perCallCap);
    if (cap !== null && decoded.args.amount > cap) novelty.push('over_cap');
    // budget-existence: a structured spend against a token with no on-chain budget would
    // revert BudgetNotSet — surface as over_budget (owner must propose the budget), NOT
    // over_cap (a set-but-exceeded budget) so the JIT card says the right thing.
    if (decoded.args.spendToken !== ZERO && !grant.budgets.has(decoded.args.spendToken.toLowerCase())) {
      novelty.push('over_budget');
    }
  }

  if (novelty.length > 0) return { lane: 'l2', novelty: dedupe(novelty) };
  return { lane: 'l1', reason: 'in_envelope' };
}

function dedupe(n: Novelty[]): Novelty[] {
  return [...new Set(n)];
}

function safeBig(s: string): bigint | null {
  if (!/^\d{1,40}$/.test(s)) return null;
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}
