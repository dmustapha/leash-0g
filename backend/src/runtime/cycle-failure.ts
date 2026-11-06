import { BaseError, ContractFunctionRevertedError, HttpRequestError, TimeoutError } from 'viem';

/**
 * AQ-FND beta slice step 3 — plain-language cycle failures.
 *
 * A cycle that throws used to surface its RAW message to the owner (viem's multi-line dump with
 * URLs, request bodies and addresses) in both the trace summary and the alert. This maps an error
 * to ONE plain sentence. The full text is never lost: callers keep it in `rawError`.
 */

const MAX_PLAIN = 160;
export const MAX_RAW_ERROR = 2000;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const firstLine = (s: string): string => (s.split('\n')[0] ?? '').trim();

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** viem wraps causes; find the first matching class anywhere in the chain. */
function findCause<T extends Error>(err: unknown, ctor: new (...a: never[]) => T): T | null {
  if (err instanceof ctor) return err;
  return err instanceof BaseError ? (err.walk((e) => e instanceof ctor) as T | null) : null;
}

const RETRY = ' It will try again.';

/**
 * `retrying` = the loop will actually run another cycle. The pause alert passes false so it never
 * says "it will try again" about an agent that has just stopped itself.
 */
export function describeCycleFailure(err: unknown, opts: { retrying?: boolean } = {}): string {
  const plain = describeRaw(err);
  return opts.retrying === false ? plain.replace(RETRY, '') : plain;
}

function describeRaw(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);

  const gateway = /gateway refused inference: status (\d{3})/.exec(message);
  if (gateway) return `The reasoning service didn't answer (status ${gateway[1]}).${RETRY}`;

  const http = findCause(err, HttpRequestError);
  const timeout = findCause(err, TimeoutError);
  if (http || timeout) {
    const host = hostOf((http ?? timeout)?.url);
    return `The network node${host ? ` (${host})` : ''} didn't respond.${RETRY}`;
  }

  const reverted = findCause(err, ContractFunctionRevertedError);
  if (reverted) return clip(`The chain refused a call: ${firstLine(reverted.shortMessage)}`, MAX_PLAIN);

  const line = err instanceof BaseError ? err.shortMessage : firstLine(message);
  return clip(firstLine(line) || 'An unexpected error occurred.', MAX_PLAIN);
}

/** The full original error text for the trace's `rawError` field (capped). */
export function rawErrorText(err: unknown): string {
  return clip(err instanceof Error ? err.message : String(err), MAX_RAW_ERROR);
}
