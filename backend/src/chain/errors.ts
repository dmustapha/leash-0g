import { BaseError, ContractFunctionRevertedError, decodeErrorResult, toFunctionSelector } from 'viem';
import { leashAccountAbi, leashAccountV4Abi } from './abis.js';
import type { DecodedLeashError } from '../types.js';
import type { Json } from '../crypto/canonical.js';

/**
 * P3C-6(ii): decode LeashAccount custom errors into {errorName, args, plain}.
 * The plain string is the SHARED plain-language copy (00 §2c) — the web app
 * ships the same map (web/lib/leash-errors.ts) so cockpit and inbox never
 * show a raw selector. Covers the v1/v3 account AND the Stage-D V4 governed-call
 * wall (D-10/D-13) so a governed-call revert also surfaces plain language.
 */

const v1Errors = leashAccountAbi.filter((item) => item.type === 'error');
const v4Errors = leashAccountV4Abi.filter((item) => item.type === 'error');
// Merge, deduping by name (V4 adds only Stage-D-specific errors; no name clash).
const v1Names = new Set<string>(v1Errors.map((e) => e.name));
const errorAbi = [...v1Errors, ...v4Errors.filter((e) => !v1Names.has(e.name))];

/** All error names (v1/v3 + Stage-D V4) — pinned by test against the contract source. */
export const LEASH_ERROR_NAMES = errorAbi.map((e) => e.name);

export function plainLeashError(errorName: string, args: Json): string {
  const a = args as Record<string, Json | undefined> & { [k: number]: Json | undefined };
  switch (errorName) {
    case 'NotOwner':
      return 'Only the owner wallet can do this.';
    case 'NotGuardianOrOwner':
      return 'Only the guardian or the owner wallet can do this.';
    case 'NotSessionKey':
      return "Only the agent's own session key can act from this account.";
    case 'AccountRevoked':
      return 'This agent is revoked — its account refuses every action.';
    case 'AccountNotRevoked':
      return 'This only works after the agent has been revoked.';
    case 'SessionExpired':
      return "The agent's session has expired — re-arm it to allow acting again.";
    case 'NotAllowlisted':
      return `That address is not on the allowlist${typeof a[0] === 'string' ? ` (${String(a[0])})` : ''} — the account refuses to pay it.`;
    case 'ZeroAddress':
      return 'The zero address is never a valid target.';
    case 'CalldataForbidden':
      return 'This account only makes plain transfers — contract calls are not allowed.';
    case 'OverPerTransferCap':
      return `That single transfer is over the per-transfer cap${caps(a)} — the account refuses it no matter who asks.`;
    case 'OverWindowCap':
      return `That would go over the spending window cap${caps(a)} — the window has to reset (or the owner raise it) first.`;
    case 'CallFailed':
      return 'The transfer itself failed at the receiving address.';
    case 'NothingPending':
      return 'There is no pending policy change to apply.';
    case 'TimelockNotElapsed':
      return 'The safety delay on this policy change has not elapsed yet.';
    case 'NotLoosening':
      return 'This path is only for changes that loosen policy — tightening applies instantly.';
    case 'NotTightening':
      return 'This path is only for changes that tighten policy.';
    case 'InvalidPolicy':
      return 'That policy configuration is not valid.';
    case 'NoSettlementToken':
      return 'This account is native-only — it has no settlement token configured, so token transfers are not allowed.';
    case 'TokenNotAllowlisted':
      return `That token is not this account’s settlement token${typeof a[0] === 'string' ? ` (${String(a[0])})` : ''} — the account refuses to move it.`;
    case 'OverPerTransferCapToken':
      return `That single token transfer is over the per-transfer cap${caps(a)} — the account refuses it no matter who asks.`;
    case 'OverWindowCapToken':
      return `That would go over the token spending-window cap${caps(a)} — the window has to reset (or the owner raise it) first.`;
    case 'TokenTransferFailed':
      return 'The token transfer itself failed (the token rejected it or returned false).';
    // Stage-D V4 governed-call wall (D-10/D-13).
    case 'TargetNotAllowlisted':
      return `That contract is not on the agent’s allowlist${typeof a[0] === 'string' ? ` (${String(a[0])})` : ''} — grant the capability first.`;
    case 'SelectorNotAllowlisted':
      return 'That function is not granted on this contract — grant the capability first.';
    case 'SelfCallForbidden':
      return 'The account can never call itself — that action is refused.';
    case 'InfiniteApprovalForbidden':
      return 'Unlimited (infinite) approvals are never allowed — approve a specific amount instead.';
    case 'BlanketApprovalForbidden':
      return 'Blanket “approve-for-all” is never allowed on this account.';
    case 'RecipientNotSelf':
      return `That call would send funds to another address${typeof a[0] === 'string' ? ` (${String(a[0])})` : ''} — this capability only lets the agent act for itself.`;
    case 'SpenderNotAllowlisted':
      return `That spender is not on the grant${typeof a[0] === 'string' ? ` (${String(a[0])})` : ''} — approve it first.`;
    case 'OverPerCallCap':
      return `That call is over its per-call cap${caps(a)} — the account refuses it no matter who asks.`;
    case 'OverCumulativeSpend':
      return `That would go over the cumulative spending budget${caps(a)} — the window has to reset (or the owner raise it) first.`;
    case 'OverCallWindowCap':
      return `That would go over this call’s spending-window cap${caps(a)} — the window has to reset (or the owner raise it) first.`;
    case 'BudgetNotSet':
      return 'No spending budget is set for that token — the owner has to set one before the agent can spend it.';
    case 'DecodeMismatch':
      return 'The call arguments did not match the expected safe shape — the account refuses to guess.';
    case 'CodehashMismatch':
      return 'The target contract’s code changed from what was pinned — the account refuses to call it.';
    case 'OneShotExpired':
      return 'That one-time approval has expired — ask the owner to approve it again.';
    case 'EmptyCodeTarget':
      return 'That target has no contract code — the account refuses to call an empty address.';
    default:
      return 'The account contract refused this action.';
  }
}

function caps(a: { [k: number]: Json | undefined }): string {
  const attempted = a[0];
  const cap = a[1];
  if (typeof attempted === 'string' && typeof cap === 'string') {
    return ` (${attempted} wei vs cap ${cap} wei)`;
  }
  return '';
}

/**
 * Decode from anything the act path can throw: a viem error chain (walks to
 * ContractFunctionRevertedError), or raw revert data / a message containing
 * the 8-hex-digit selector. Null when it is not a LeashAccount error.
 */
export function decodeLeashError(err: unknown): DecodedLeashError | null {
  // viem error chain (the normal path — the ABI carries the error defs).
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName ?? reverted.signature;
      if (name !== undefined) {
        const found = errorAbi.find((e) => e.name === name);
        if (found) {
          const args = (reverted.data?.args ?? []).map(jsonify) as Json;
          return { errorName: found.name, args, plain: plainLeashError(found.name, args) };
        }
      }
    }
  }
  // Raw revert data (0x + selector + args) — fixtures, logs, RPC messages.
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const dataMatch = /0x[0-9a-fA-F]{8,}/.exec(text);
  if (dataMatch) {
    try {
      const decoded = decodeErrorResult({ abi: errorAbi, data: dataMatch[0] as `0x${string}` });
      const args = (decoded.args ?? []).map(jsonify) as Json;
      return { errorName: decoded.errorName, args, plain: plainLeashError(decoded.errorName, args) };
    } catch {
      // fall through to bare-selector matching
    }
  }
  const selMatch = /0x[0-9a-fA-F]{8}\b/.exec(text);
  if (selMatch) {
    const sel = selMatch[0].toLowerCase();
    for (const e of errorAbi) {
      const signature = `${e.name}(${e.inputs.map((i) => i.type).join(',')})`;
      if (toFunctionSelector(signature).toLowerCase() === sel) {
        return { errorName: e.name, args: [], plain: plainLeashError(e.name, []) };
      }
    }
  }
  return null;
}

function jsonify(v: unknown): Json {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) return v;
  return JSON.stringify(v); // error args are scalars in practice; objects stay inspectable
}
