import { encodeAbiParameters, keccak256, type Hex } from 'viem';

/**
 * The one-shot authorization key (D-7), byte-identical to the on-chain
 * `LeashAccountV4.executeCall`:
 *   callHash = keccak256(abi.encode(target, selector, data, value))
 * where `selector = bytes4(data[0:4])`. The owner authorizes THIS exact hash via
 * `authorizeOnce`; the account consumes it on the first matching call. Computing
 * it here (never from model text) keeps approve-once bound to the exact reviewed
 * bytes — a different call can never satisfy a one-shot (D-7 replay guard).
 */
export function computeCallHash(target: string, value: bigint, data: string): Hex {
  const hex = (data && data.startsWith('0x') ? data : '0x') as Hex;
  const selector = (hex.length >= 10 ? hex.slice(0, 10) : '0x00000000') as Hex;
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'bytes4' }, { type: 'bytes' }, { type: 'uint256' }],
      [target as Hex, selector, hex, value],
    ),
  );
}
