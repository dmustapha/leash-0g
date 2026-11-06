import type { Pool } from 'pg';
import {
  listOpenRailTransfers,
  markSourceConfirmed,
  markAttested,
  recordFillSubmitted,
  markFilled,
  markNoFill,
  claimRecovery,
  requeueRecovery,
  markRefunded,
  markFailed,
  type RailTransferRow,
} from '../store/rail-transfers.js';

/**
 * The rail recovery sweep (AQ-FND M-4) — the active half of the no-fill → refund
 * → retry state machine. It is the cross-chain sibling of `jobs/settlement-sweep`:
 * every write-ahead hash a leg broadcast is reconciled against the chain once per
 * tick, and an un-filled transfer is advanced through recovery instead of being
 * dropped as an error.
 *
 *   initiated        → read src receipt → source_confirmed | failed
 *   source_confirmed → fetch proof      → attested          | (window elapsed → no_fill)
 *   attested         → submit fill      → filling
 *   filling          → read dest receipt→ filled            | (window elapsed → no_fill)
 *   no_fill          → claim + recover  → recovering        | (attempts exhausted → failed)
 *   recovering       → read recovery tx → filled | refunded | no_fill (re-armed)
 *
 * CCTP recovers FORWARD (re-mint the retained message bytes — M-4 forward-only
 * self-rescue); CCIP recovers by REFUND on expiry. `recovery_mode` decides which,
 * so the sweep never backward-refunds a CCTP leg whose funds are already burned.
 *
 * Idempotent by construction: every advance is a CAS on the expected `status`, so
 * overlapping ticks or a racing driver write exactly once. The RAIL-SPECIFIC legs
 * (how to fetch a Circle attestation, how to submit a mint / ccipReceive / refund
 * on a given rail) are the injected `RailDriver` — route EXECUTION stays a
 * consumer concern (A3/A5, spec §M-4); this module owns only the recovery POLICY.
 */

export type ReceiptStatus = 'success' | 'reverted' | 'pending';

/** The outcome of a rail-specific leg the driver runs for the sweep. */
export type ProofResult =
  | { kind: 'ready'; attestation?: string | null; messageBytes?: string | null }
  | { kind: 'pending' };

export interface RailDriver {
  /** receipt status of a write-ahead hash on a given chain. */
  getReceiptStatus(chainId: number, txHash: string): Promise<ReceiptStatus>;
  /** fetch the off-chain proof (CCTP attestation / CCIP commit) for a confirmed source leg. */
  fetchProof(row: RailTransferRow): Promise<ProofResult>;
  /** submit the destination fill (CCTP mint / CCIP exec) — returns the broadcast hash. */
  submitFill(row: RailTransferRow): Promise<string>;
  /** submit the refund leg (CCIP refund-on-expiry) — returns the broadcast hash. */
  submitRefund(row: RailTransferRow): Promise<string>;
}

export interface RailRecoveryDeps {
  pool: Pool;
  driver: RailDriver;
  /** how long a source-confirmed/filling leg may sit before it is declared no_fill. */
  fillTimeoutMs?: number;
  /** backoff before a no_fill row is worked again. */
  retryBackoffMs?: number;
  now?: () => number;
}

export interface RailRecoveryResult {
  checked: number;
  advanced: number;
  filled: number;
  refunded: number;
  failed: number;
  stillOpen: number;
}

const DEFAULT_FILL_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_RETRY_BACKOFF_MS = 60_000;

export async function sweepRailRecovery(deps: RailRecoveryDeps): Promise<RailRecoveryResult> {
  const now = deps.now ?? Date.now;
  const fillTimeout = deps.fillTimeoutMs ?? DEFAULT_FILL_TIMEOUT_MS;
  const backoff = deps.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  const result: RailRecoveryResult = { checked: 0, advanced: 0, filled: 0, refunded: 0, failed: 0, stillOpen: 0 };

  const rows = await listOpenRailTransfers(deps.pool);
  for (const row of rows) {
    result.checked += 1;
    try {
      const advanced = await advanceOne(deps, row, { now: now(), fillTimeout, backoff, result });
      if (advanced) result.advanced += 1;
      else result.stillOpen += 1;
    } catch (err) {
      // A single row's failure must not abandon the rest of the work set, nor
      // resolve THIS row — it stays open and is retried next tick.
      result.stillOpen += 1;
      console.error(`[rail-recovery] ${row.railId} (${row.rail} ${row.status}) reconciliation failed`, err);
    }
  }
  if (result.checked > 0) {
    console.log(
      `[rail-recovery] checked=${result.checked} advanced=${result.advanced} filled=${result.filled} ` +
        `refunded=${result.refunded} failed=${result.failed} open=${result.stillOpen}`,
    );
  }
  return result;
}

interface Tick {
  now: number;
  fillTimeout: number;
  backoff: number;
  result: RailRecoveryResult;
}

/** Advance one row by at most one state. Returns true iff the row moved. */
async function advanceOne(deps: RailRecoveryDeps, row: RailTransferRow, t: Tick): Promise<boolean> {
  const ageMs = t.now - new Date(row.updatedAt).getTime();
  const backoffAt = new Date(t.now + t.backoff);

  switch (row.status) {
    case 'initiated': {
      if (!row.srcTx) {
        // The originator write-aheads the burn hash right after broadcasting. A row that is still hash-less
        // past the window means the process died between opening the row and (maybe) broadcasting. It must
        // not stay open forever (it blocks that agent from ever bridging again), but it may have burned:
        // fail it LOUDLY so a human checks the chain before the agent retries.
        if (ageMs >= t.fillTimeout) {
          await markFailed(
            deps.pool,
            row.railId,
            'no source transaction was recorded within the window — verify on-chain whether the burn landed before retrying',
          );
          console.warn(`[rail-recovery] ${row.railId} (${row.rail}) has no recorded source tx after the window — failed, needs a look`);
          result_bump(t, 'failed');
          return true;
        }
        return false;
      }
      const st = await deps.driver.getReceiptStatus(row.srcChainId, row.srcTx);
      if (st === 'pending') return false;
      if (st === 'reverted') {
        await markFailed(deps.pool, row.railId, `source leg reverted (tx ${row.srcTx})`);
        result_bump(t, 'failed');
        return true;
      }
      return markSourceConfirmed(deps.pool, row.railId);
    }

    case 'source_confirmed': {
      const proof = await deps.driver.fetchProof(row);
      if (proof.kind === 'ready') {
        return markAttested(deps.pool, row.railId, {
          attestation: proof.attestation ?? null,
          messageBytes: proof.messageBytes ?? null,
        });
      }
      // proof still pending — if the window elapsed, this is a no-fill (recovery owns it).
      if (ageMs >= t.fillTimeout) {
        await markNoFill(deps.pool, row.railId, { nextAttemptAt: backoffAt, lastError: 'proof not ready within fill window' });
        return true;
      }
      return false;
    }

    case 'attested': {
      const destTx = await deps.driver.submitFill(row);
      return recordFillSubmitted(deps.pool, row.railId, destTx);
    }

    case 'filling': {
      if (!row.destTx) return false;
      const st = await deps.driver.getReceiptStatus(row.destChainId, row.destTx);
      if (st === 'pending') {
        if (ageMs >= t.fillTimeout) {
          await markNoFill(deps.pool, row.railId, { nextAttemptAt: backoffAt, lastError: 'fill unconfirmed within window' });
          return true;
        }
        return false;
      }
      if (st === 'reverted') {
        await markNoFill(deps.pool, row.railId, { nextAttemptAt: backoffAt, lastError: `fill reverted (tx ${row.destTx})` });
        return true;
      }
      await markFilled(deps.pool, row.railId);
      result_bump(t, 'filled');
      return true;
    }

    case 'no_fill': {
      const claimed = await claimRecovery(deps.pool, row.railId);
      if (!claimed) {
        // either another tick claimed it, or attempts are exhausted — if the latter, fail loudly.
        if (row.attemptCount >= row.maxAttempts) {
          await markFailed(deps.pool, row.railId, `recovery exhausted after ${row.attemptCount} attempts`);
          console.warn(`[rail-recovery] ${row.railId} (${row.rail}) recovery EXHAUSTED — needs a look`);
          result_bump(t, 'failed');
          return true;
        }
        return false;
      }
      try {
        if (claimed.recoveryMode === 'forward_mint') {
          // Forward-only self-rescue (CCTP): the source value is already committed, so
          // we never refund backward — we drive the fill forward. If the off-chain proof
          // never arrived (the no-fill was a proof timeout), re-fetch it first; only once
          // we hold the message do we re-submit the mint/exec.
          if (!claimed.messageBytes && !claimed.attestation) {
            const proof = await deps.driver.fetchProof(claimed);
            if (proof.kind === 'pending') {
              await requeueRecovery(deps.pool, claimed.railId, {
                nextAttemptAt: new Date(t.now + t.backoff),
                lastError: `proof still pending at recovery attempt ${claimed.attemptCount}`,
              });
              return true;
            }
            await markAttested(deps.pool, claimed.railId, {
              attestation: proof.attestation ?? null,
              messageBytes: proof.messageBytes ?? null,
            });
            return true; // now 'attested' → the next tick submits the fill
          }
          const destTx = await deps.driver.submitFill(claimed);
          return recordFillSubmitted(deps.pool, claimed.railId, destTx);
        }
        // Refund-on-expiry: return the funds on the source chain (TERMINAL).
        const refundTx = await deps.driver.submitRefund(claimed);
        await markRefunded(deps.pool, claimed.railId, refundTx);
        result_bump(t, 'refunded');
        return true;
      } catch (err) {
        await requeueRecovery(deps.pool, claimed.railId, {
          nextAttemptAt: new Date(t.now + t.backoff),
          lastError: `recovery attempt ${claimed.attemptCount} failed: ${(err as Error).message.slice(0, 160)}`,
        });
        return true;
      }
    }

    case 'recovering': {
      // a recovery fill is in flight on dest_tx; reconcile it like `filling`.
      if (!row.destTx) return false;
      const st = await deps.driver.getReceiptStatus(row.destChainId, row.destTx);
      if (st === 'pending') return false;
      if (st === 'reverted') {
        await requeueRecovery(deps.pool, row.railId, { nextAttemptAt: backoffAt, lastError: `recovery fill reverted (tx ${row.destTx})` });
        return true;
      }
      await markFilled(deps.pool, row.railId);
      result_bump(t, 'filled');
      return true;
    }

    default:
      return false;
  }
}

function result_bump(t: Tick, k: 'filled' | 'refunded' | 'failed'): void {
  t.result[k] += 1;
}
