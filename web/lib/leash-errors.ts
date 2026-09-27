// File: web/lib/leash-errors.ts
// P3C-6(ii): plain-language copy for ALL LeashAccount custom errors, mirroring
// backend/src/chain/errors.ts plainLeashError (the no-args variants) EXACTLY. The cockpit and
// inbox render this copy — never a raw selector; the raw errorName lives behind a Disclosure.
// Phase-4 adds the 5 governed-ERC-20 settlement errors (v3 executeTokenTransfer).

export const LEASH_ERROR_COPY = {
  NotOwner: 'Only the owner wallet can do this.',
  NotGuardianOrOwner: 'Only the guardian or the owner wallet can do this.',
  NotSessionKey: "Only the agent's own session key can act from this account.",
  AccountRevoked: 'This agent is revoked — its account refuses every action.',
  AccountNotRevoked: 'This only works after the agent has been revoked.',
  SessionExpired: "The agent's session has expired — re-arm it to allow acting again.",
  NotAllowlisted: 'That address is not on the allowlist — the account refuses to pay it.',
  ZeroAddress: 'The zero address is never a valid target.',
  CalldataForbidden: 'This account only makes plain transfers — contract calls are not allowed.',
  OverPerTransferCap:
    'That single transfer is over the per-transfer cap — the account refuses it no matter who asks.',
  OverWindowCap:
    'That would go over the spending window cap — the window has to reset (or the owner raise it) first.',
  CallFailed: 'The transfer itself failed at the receiving address.',
  NothingPending: 'There is no pending policy change to apply.',
  TimelockNotElapsed: 'The safety delay on this policy change has not elapsed yet.',
  NotLoosening: 'This path is only for changes that loosen policy — tightening applies instantly.',
  NotTightening: 'This path is only for changes that tighten policy.',
  InvalidPolicy: 'That policy configuration is not valid.',
  // Phase-4 governed ERC-20 settlement (v3 executeTokenTransfer) — the no-args
  // copy; the amount/cap variants are composed backend-side into the trace.
  NoSettlementToken:
    'This account is native-only — it has no settlement token configured, so token transfers are not allowed.',
  TokenNotAllowlisted: 'That token is not this account’s settlement token — the account refuses to move it.',
  OverPerTransferCapToken:
    'That single token transfer is over the per-transfer cap — the account refuses it no matter who asks.',
  OverWindowCapToken:
    'That would go over the token spending-window cap — the window has to reset (or the owner raise it) first.',
  TokenTransferFailed: 'The token transfer itself failed (the token rejected it or returned false).',
  // Stage-D V4 governed-call wall (D-10/D-13) — the no-args copy; amount/cap
  // variants are composed backend-side into the trace.
  TargetNotAllowlisted: 'That contract is not on the agent’s allowlist — grant the capability first.',
  SelectorNotAllowlisted: 'That function is not granted on this contract — grant the capability first.',
  SelfCallForbidden: 'The account can never call itself — that action is refused.',
  InfiniteApprovalForbidden: 'Unlimited (infinite) approvals are never allowed — approve a specific amount instead.',
  BlanketApprovalForbidden: 'Blanket “approve-for-all” is never allowed on this account.',
  RecipientNotSelf: 'That call would send funds to another address — this capability only lets the agent act for itself.',
  SpenderNotAllowlisted: 'That spender is not on the grant — approve it first.',
  OverPerCallCap: 'That call is over its per-call cap — the account refuses it no matter who asks.',
  OverCumulativeSpend:
    'That would go over the cumulative spending budget — the window has to reset (or the owner raise it) first.',
  OverCallWindowCap:
    'That would go over this call’s spending-window cap — the window has to reset (or the owner raise it) first.',
  BudgetNotSet: 'No spending budget is set for that token — the owner has to set one before the agent can spend it.',
  DecodeMismatch: 'The call arguments did not match the expected safe shape — the account refuses to guess.',
  CodehashMismatch: 'The target contract’s code changed from what was pinned — the account refuses to call it.',
  OneShotExpired: 'That one-time approval has expired — ask the owner to approve it again.',
  EmptyCodeTarget: 'That target has no contract code — the account refuses to call an empty address.',
} as const satisfies Record<string, string>;

export type LeashErrorName = keyof typeof LEASH_ERROR_COPY;

/** Fallback matches the backend's default branch — still plain language, never a selector. */
export const LEASH_ERROR_FALLBACK = 'The account contract refused this action.';

export function plainLeashError(errorName: string): string {
  return (LEASH_ERROR_COPY as Record<string, string>)[errorName] ?? LEASH_ERROR_FALLBACK;
}
