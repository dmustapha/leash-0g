import { decodeLeashError } from '../../chain/errors.js';
import type { TxErrorClass } from './errors.js';

/**
 * Class of a failure from simulating/sending a tx.
 *   permanent : the wall (or the chain) refused it on its merits; retrying cannot help
 *   transient : transport/RPC trouble; the same action may succeed later
 */
export function classifySendError(err: unknown): TxErrorClass {
  if (decodeLeashError(err)) return 'permanent';
  const msg = err instanceof Error ? err.message : String(err);
  if (/execution reverted|revert|insufficient funds|exceeds (allowance|balance)|invalid opcode/i.test(msg)) return 'permanent';
  return 'transient';
}

/** Send-time errors that mean "the chain already has / consumed this" — reconcile, never rebuild. */
export function isAlreadyKnown(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /already known|known transaction|already imported|ALREADY_EXISTS/i.test(msg);
}
export function isNonceTooLow(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /nonce too low|nonce is too low|NonceTooLow|nonce has already been used/i.test(msg);
}
