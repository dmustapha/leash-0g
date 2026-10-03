import { keccak256, stringToHex, type Hex } from 'viem';
import { canonicalJson } from '../crypto/canonical.js';
import type { Json } from '../crypto/canonical.js';

/**
 * The tool-call one-shot key (SF-3) — the tool analogue of `computeCallHash`.
 * Binds a JIT approval to the EXACT reviewed tool call: a different tool or
 * different args produces a different hash, so an approve-once can never be
 * reused for another call (replay guard), and the idempotent `(agent, call_hash)`
 * pending index raises exactly ONE card per novel call.
 *
 * `chainId` is bound in (mirror of the on-chain one-shot's `block.chainid`) so a
 * tool approval on chain A can never be replayed against a same-address account
 * on chain B. Args are serialized with the deterministic canonical serializer so
 * key order never changes the preimage.
 */
export function computeToolCallHash(chainId: number | bigint, toolId: string, args: Json): Hex {
  const preimage = canonicalJson({ chainId: Number(chainId), toolId: toolId.toLowerCase(), args });
  return keccak256(stringToHex(preimage));
}
