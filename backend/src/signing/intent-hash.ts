import { keccak256, stringToHex, type Hex } from 'viem';
import { canonicalJson } from '../crypto/canonical.js';

/**
 * The signing-request one-shot key (FP-2) — the signing analogue of
 * `computeToolCallHash`/`computeCallHash`. Binds a JIT approval to the EXACT
 * reviewed signing: a different descriptor / spender / amount / deadline produces
 * a different hash, so an approve-once can never be reused for another sign, and
 * the idempotent `(agent, request_hash)` pending index raises exactly ONE card per
 * novel signing. `chainId` is bound in (mirror of the on-chain descriptor's
 * chainId-bound domain) so a signing approval on chain A can never be replayed
 * against a same-address account on chain B.
 */
export function computeSigningRequestHash(
  chainId: number | bigint,
  descriptorId: number,
  spender: string,
  amountWei: string,
  deadlineSec: number,
): Hex {
  const preimage = canonicalJson({
    chainId: Number(chainId),
    descriptorId,
    spender: spender.toLowerCase(),
    amountWei,
    deadlineSec,
  });
  return keccak256(stringToHex(preimage));
}
