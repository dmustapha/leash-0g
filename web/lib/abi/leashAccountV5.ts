// File: web/lib/abi/leashAccountV5.ts
// V5 owner-write grammar for the web owner-arming path (Phase A2, closing TA-ABI-5). LeashAccountV5
// is a superset of V4: it inherits the governed-calldata grammar (call rules, spend budget, price
// band) and adds the governed-SIGNING surface (the session-key arm + the owner grant grammar).
// Derived with viem parseAbi from the human-readable signatures — byte-exact to backend
// chain/abis.ts (leashAccountV4Abi + leashAccountV5SigningAbi) and the compiled LeashAccountV5
// artifact. Never hand-write JSON: parseAbi keeps the selectors canonical, and
// tests/abi-v5-parity.test.ts pins every write fragment to the Foundry artifact's selector.
import { parseAbi } from 'viem';

import { LEASH_ACCOUNT_V4_ABI } from './leashAccountV4';

// The V5-only governed-signing fragments. Mirrors backend leashAccountV5SigningAbi: the session-key
// arm (authorizeSigningIntent), disarm, the co-signer second factor, and the owner grant grammar
// (nested propose → shared apply → tighten/remove). Reads mirror the on-chain signing policy.
export const LEASH_ACCOUNT_V5_SIGNING_ABI = parseAbi([
  // the session-key arm (runtime write) — returns the armed digest. Slice-5: `caps` is the reviewed
  // per-token TokenCap[] allowlist (empty `[]` for standard/order, verified against tokenCapsHash for batch).
  'function authorizeSigningIntent(uint256 descriptorId, bytes32[] fields, (address token, uint128 cap)[] caps, bytes sessionSig, bytes coSignerSig) returns (bytes32 digest)',
  'function disarmSigningIntent(bytes32 digest)',
  // co-signer second factor — owner setter (instant add / timelocked weaken) + reads.
  'function setCoSigner(address next)',
  'function applyCoSigner()',
  'function coSigner() view returns (address)',
  'function pendingCoSigner() view returns (address)',
  'function pendingCoSignerEta() view returns (uint64)',
  // owner grant grammar — the unified nested propose (flat = zeroed fold), shared apply (timelocked
  // loosen), tighten/remove (instant restriction).
  'function proposeSigningGrantNested((uint256 descriptorId, bytes32 domainSeparator, bytes32 typeHash, uint8 numTopFields, uint8 spenderLeafIndex, uint8 amountLeafIndex, uint8 deadlineLeafIndex, uint8 expiryLeafIndex, bytes32 nestedTypeHash, uint8 nestedLeafStart, uint8 nestedLeafCount, address token, uint128 perIntentCap, uint64 maxDeadlineWindow, uint8 kind, address buyToken) p, address[] spenders, (address token, uint128 cap)[] caps)',
  'function applySigningGrant()',
  'function tightenSigningGrant(uint256 descriptorId, uint128 perIntentCap, uint64 maxDeadlineWindow)',
  'function removeSigningDescriptor(uint256 descriptorId)',
  // reads (the read-model mirrors these; the on-chain account stays authoritative)
  'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)',
  'function signingEpoch() view returns (uint64)',
  'function signingSpender(uint256, address) view returns (bool)',
  'function armedIntent(bytes32) view returns (bool set, uint64 expiry, uint64 epoch)',
  // events
  'event SigningIntentAuthorized(uint256 indexed descriptorId, bytes32 indexed digest, address spender, uint256 amount, uint64 deadline)',
  'event SigningGrantProposed(uint256 indexed descriptorId, uint64 eta)',
  'event SigningGrantChanged(uint256 indexed descriptorId, address token, uint128 perIntentCap)',
  // errors (decode reverts to plain language in the cockpit / drill)
  'error DescriptorNotRegistered(uint256 descriptorId)',
  'error BadIntentSignature()',
  'error DeadlineInPast()',
  'error DeadlineTooFar(uint256 deadline)',
  'error OverPerIntentCap(uint256 amount, uint128 cap)',
  'error SpenderNotAllowlisted(address spender)',
  'error AlreadyArmed()',
  'error DecodeMismatch()',
  'error InvalidPolicy()',
  'error NotSessionKey()',
]);

// Shared V4-grammar writes the owner/agent path encodes that the reduced web V4 read-ABI module omits
// (the three spend paths + the instant tighten-spend). Byte-exact to backend leashAccountV4Abi so a V5
// account's full owner-write surface is present. parseAbi keeps the selectors canonical.
export const LEASH_ACCOUNT_V5_SPEND_ABI = parseAbi([
  'function execute(address to, uint256 value, bytes data)',
  'function executeTokenTransfer(address token, address to, uint256 amount)',
  'function executeCall(address target, uint256 value, bytes data)',
  'function tightenSpendBudget(address token, uint128 windowCap)',
]);

// The V5 price-band propose/apply the owner panel encodes. tightenPriceBand (instant) and
// enableRequireBandForSwap (the one-way swap-wall latch) already ride in the V4 module; propose/apply
// add the timelocked loosen path.
export const LEASH_ACCOUNT_V5_BAND_ABI = parseAbi([
  'function proposePriceBand(address target, bytes4 selector, address feed, address asset, uint32 maxDeviationBps, uint64 maxStaleness)',
  'function applyPriceBand()',
]);

// The full V5 owner-write ABI: the inherited V4 grammar + the V5 signing surface + the band
// arm/propose/apply. This is the ABI the FE hands Privy writeContract/encodeFunctionData for a V5
// account. V5 is a superset of V4, so most fragments are shared; the signing fragments are V5-only.
export const LEASH_ACCOUNT_V5_ABI = [
  ...LEASH_ACCOUNT_V4_ABI,
  ...LEASH_ACCOUNT_V5_SPEND_ABI,
  ...LEASH_ACCOUNT_V5_SIGNING_ABI,
  ...LEASH_ACCOUNT_V5_BAND_ABI,
] as const;

/** The account grammar versions the FE can arm against. V5 is a superset of V4. */
export type AccountVersion = 4 | 5;

/**
 * Version-aware account-ABI selector. Given an account's grammar version, return the ABI the FE
 * hands Privy `writeContract` / viem `encodeFunctionData`. V5 adds the governed-signing surface
 * (and the band propose/apply path) on top of the shared V4 grammar — so a V4 account never sees a
 * V5-only fragment, and a V5 account sees the full superset. Phase B panels call this with the
 * account's version and encode against the returned ABI.
 */
export function accountAbiForVersion(version: AccountVersion) {
  return version === 5 ? LEASH_ACCOUNT_V5_ABI : LEASH_ACCOUNT_V4_ABI;
}
