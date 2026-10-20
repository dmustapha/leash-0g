import type { Pool } from 'pg';
import type { Json } from '../crypto/canonical.js';
import type { SseHub } from '../sse/hub.js';
import { traceEvent } from '../sse/events.js';
import { appendTrace } from '../trace/trace-store.js';
import { appendOwnerRecord } from '../store/owner-records.js';
import {
  listSettlingWithPendingTx,
  recordSettlement,
  markJobStatus,
  type JobRow,
} from '../store/jobs.js';
import { poaFromJobRow } from './poa.js';
import type { RuntimeChain } from '../runtime/session-chain.js';

/**
 * The settlement reconciliation sweep — the second half of the write-ahead fix.
 *
 * `jobs/graph.ts` persists a fee-transfer hash the instant it is broadcast, then
 * waits for the receipt. When that wait comes back unresolved the job is LEFT in
 * 'settling' with `settlement_tx_pending` set, because "we could not read the
 * receipt" is not "the transfer failed" — on 0G a receipt is routinely
 * unreadable for a tx that landed fine. This sweep is what eventually answers
 * the question, by asking the chain once per tick:
 *
 *   success  → promote to 'settled': settlement_tx, the signed PoA, the owner
 *              record, AND the `detail.category === 'jobFee'` trace. That trace
 *              is the owner digest's ONLY input for a job fee, so omitting it
 *              would leave the digest blind and make this whole fix cosmetic.
 *   reverted → 'failed'. The transfer provably did not move value.
 *   pending  → leave it. Next tick asks again. Never auto-failed on age; an
 *              aged row is logged loudly so a human can look, because guessing
 *              'failed' on a maybe-paid transfer is the bug being fixed.
 *
 * A 'settling' row with NO pending hash is deliberately untouched: the claim
 * won but the broadcast outcome was never recorded, so nothing here knows
 * whether value moved. Auto-failing it is exactly the wrong default.
 *
 * Idempotent by construction: every write is a CAS on `status = 'settling'`, so
 * a double tick, an overlapping deploy, or a racing graph resume writes once.
 */

export interface SettlementSweepDeps {
  pool: Pool;
  chain: RuntimeChain;
  hub: SseHub;
}

export interface SettlementSweepResult {
  checked: number;
  settled: number;
  failed: number;
  stillPending: number;
}

/** A pending settlement older than this is logged as needing a human look. */
const STALE_PENDING_MS = 30 * 60_000;

export async function sweepPendingSettlements(deps: SettlementSweepDeps): Promise<SettlementSweepResult> {
  const result: SettlementSweepResult = { checked: 0, settled: 0, failed: 0, stillPending: 0 };
  if (!deps.chain.getReceiptStatus) return result;

  const rows = await listSettlingWithPendingTx(deps.pool);
  for (const job of rows) {
    const txHash = job.settlementTxPending;
    if (!txHash) continue; // the query guarantees non-null; narrow for the type
    result.checked += 1;
    try {
      const status = await deps.chain.getReceiptStatus(txHash);
      if (status === 'pending') {
        result.stillPending += 1;
        warnIfStale(job, txHash);
        continue;
      }
      if (status === 'reverted') {
        await markJobStatus(deps.pool, job.jobId, 'failed', { blockedBy: 'settlement' });
        result.failed += 1;
        console.warn(`[settlement-sweep] job ${job.jobId} settlement reverted on chain (tx ${txHash})`);
        continue;
      }
      await confirmSettled(deps, job, txHash);
      result.settled += 1;
    } catch (err) {
      // A tick failure must not abandon the rest of the work set, and must not
      // resolve THIS row either — it stays pending and is retried next tick.
      result.stillPending += 1;
      console.error(`[settlement-sweep] job ${job.jobId} reconciliation failed (tx ${txHash})`, err);
    }
  }
  if (result.checked > 0) {
    console.log(
      `[settlement-sweep] checked=${result.checked} settled=${result.settled} ` +
        `failed=${result.failed} pending=${result.stillPending}`,
    );
  }
  return result;
}

/**
 * The confirmed-settlement write, in the same order the graph's happy path uses:
 * row → owner record → trace. `recordSettlement` is the CAS, so if it did not
 * take (another writer got there first) nothing after it runs and no duplicate
 * PoA or double-counted fee trace is appended.
 */
async function confirmSettled(deps: SettlementSweepDeps, job: JobRow, txHash: string): Promise<void> {
  // ONE shared fallback table with the graph (jobs/poa.ts) — two call sites
  // choosing their own defaults would mint two different permanent PoAs.
  const poa = poaFromJobRow(job, txHash);
  const took = await recordSettlement(deps.pool, job.jobId, { settlementTx: txHash, poa });
  if (!took) {
    console.log(`[settlement-sweep] job ${job.jobId} already resolved by another writer; nothing to do`);
    return;
  }
  await appendOwnerRecord(deps.pool, job.ownerAddr, 'poa', poa as unknown as Json);

  // Byte-for-byte the shape jobs/graph.ts appends on the happy path. The owner
  // digest keys on `category === 'jobFee'`; anything else here is invisible to it.
  const detail: Record<string, Json> = {
    summary: `settled job ${job.jobId} (confirmed late by the settlement sweep, tx ${txHash})`,
    txHash,
    category: 'jobFee',
    feeToken: job.feeToken,
    feeAmountWei: job.feeAmountWei,
    jobId: job.jobId,
  };
  if (job.feeTokenSymbol !== null) detail['feeTokenSymbol'] = job.feeTokenSymbol;
  if (job.feeTokenDecimals !== null) detail['feeTokenDecimals'] = job.feeTokenDecimals;

  const rec = await appendTrace(deps.pool, { agentId: job.requesterAgentId, kind: 'action', detail });
  deps.hub.emit(job.requesterAgentId, 'trace', traceEvent(rec));
  console.log(`[settlement-sweep] job ${job.jobId} confirmed settled (tx ${txHash})`);
}

function warnIfStale(job: JobRow, txHash: string): void {
  if (!job.settlementSubmittedAt) return;
  const ageMs = Date.now() - new Date(job.settlementSubmittedAt).getTime();
  if (ageMs < STALE_PENDING_MS) return;
  // Logged, never auto-resolved. The point of the whole fix is that an unknown
  // settlement stays visibly unknown instead of being booked as one thing or
  // the other by a timer.
  console.warn(
    `[settlement-sweep] job ${job.jobId} settlement still unconfirmed after ` +
      `${Math.round(ageMs / 60_000)}m (tx ${txHash}) — needs a look`,
  );
}
