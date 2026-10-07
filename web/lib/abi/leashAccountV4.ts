// File: web/lib/abi/leashAccountV4.ts
// V4 governed-calldata grammar ABI for the web owner-write path (Stage D). Derived with viem
// parseAbi from the human-readable signatures — byte-exact to backend chain/abis.ts
// (leashAccountV4Abi) and the deployed LeashAccountV4. Never hand-write JSON: parseAbi keeps
// the selectors canonical. The FE only needs the owner-write + a couple of read signatures.
import { parseAbi } from 'viem';

export const LEASH_ACCOUNT_V4_ABI = parseAbi([
  // grant grammar (owner-only): add/loosen timelocked, tighten/remove instant
  'function proposeCallRule(address target, bytes4 selector, uint8 recipientMode, address[] spenders, uint128 perCallCap, uint128 windowCapCall, bytes32 codehash)',
  'function applyCallRule()',
  'function tightenCallRule(address target, bytes4 selector, uint128 perCallCap, uint128 windowCapCall)',
  'function removeCallSelector(address target, bytes4 selector)',
  'function removeCallTarget(address target)',
  // one-shot JIT (owner-only, instant)
  'function authorizeOnce(bytes32 callHash, uint64 expiry)',
  // per-token cumulative outflow budget (the spine)
  'function proposeSpendBudget(address token, uint128 windowCap)',
  // FR4 (F-9): the RH price-band wall — tighten is INSTANT (new band = new restriction),
  // enable latches band-required-for-every-swap (one-way owner opt-in).
  'function tightenPriceBand(address target, bytes4 selector, address feed, address asset, uint32 maxDeviationBps, uint64 maxStaleness)',
  'function enableRequireBandForSwap()',
  'function requireBandForSwap() view returns (bool)',
  'function priceBand(bytes32 ruleKey) view returns (bool set, address feed, address asset, uint32 maxDeviationBps, uint64 maxStaleness)',
  'function applySpendBudget()',
  // reads (the account stays authoritative; the read-model mirrors these)
  'function pendingCallRule() view returns (address target, bytes4 selector, uint8 recipientMode, uint128 perCallCap, uint128 windowCapCall, bytes32 codehash, uint64 eta)',
  'function pendingBudgetEta() view returns (uint64)',
]);
