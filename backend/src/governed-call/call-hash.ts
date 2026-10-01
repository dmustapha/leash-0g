import { encodeAbiParameters, keccak256, type Hex } from 'viem';

/**
 * The one-shot authorization key (D-7), byte-identical to the on-chain
 * `LeashAccountV4.executeCall`:
 *   callHash = keccak256(abi.encode(block.chainid, target, selector, data, value))
 * where `selector = bytes4(data[0:4])`. The owner authorizes THIS exact hash via
 * `authorizeOnce`; the account consumes it on the first matching call. Computing
 * it here (never from model text) keeps approve-once bound to the exact reviewed
 * bytes — a different call can never satisfy a one-shot (D-7 replay guard).
 *
 * SE-9 (carry #4): `chainId` is bound in so a one-shot authorized on chain A can
 * never be replayed against the same-CREATE2-address account on chain B — the
 * off-chain hash MUST match the wall's `block.chainid`-bound hash exactly.
 */
export function computeCallHash(chainId: number | bigint, target: string, value: bigint, data: string): Hex {
  const hex = (data && data.startsWith('0x') ? data : '0x') as Hex;
  const selector = (hex.length >= 10 ? hex.slice(0, 10) : '0x00000000') as Hex;
  return keccak256(
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'address' }, { type: 'bytes4' }, { type: 'bytes' }, { type: 'uint256' }],
      [BigInt(chainId), target as Hex, selector, hex, value],
    ),
  );
}
