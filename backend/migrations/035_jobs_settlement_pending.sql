-- The settlement-loss class. `jobs/graph.ts` broadcast a governed ERC-20 fee
-- transfer and then BLOCKED on the receipt before learning the tx hash. If the
-- receipt read threw — and on 0G it does, for txs that land fine — the catch
-- marked the job 'failed' and threw the only handle on a real, paid transfer
-- away. settlement_tx stayed NULL, no jobFee trace was appended, and the owner
-- digest (which keys on detail.category = 'jobFee') reported nothing. Money
-- moved; the system recorded that it had not.
--
-- The fix is write-ahead: persist the hash the instant the tx is broadcast,
-- BEFORE the wait, so an unresolved receipt is a reconcilable state instead of
-- a loss. A 'settling' row with a pending hash is what the settlement sweep
-- picks up; a 'settling' row WITHOUT one is deliberately left alone (the
-- broadcast outcome is unknown, and auto-failing it is the wrong default).
--
-- Nullable, no backfill, no new status value: 'settling' already exists.
-- settlement_tx remains the CONFIRMED hash — pending is never promoted into it
-- except by the sweep, on a successful receipt. search_path is set by the runner.

ALTER TABLE jobs
  ADD COLUMN settlement_tx_pending   text,
  ADD COLUMN settlement_submitted_at timestamptz;

-- The sweep scans exactly this set, every tick.
CREATE INDEX jobs_settling_pending_idx
  ON jobs (settlement_submitted_at)
  WHERE status = 'settling' AND settlement_tx_pending IS NOT NULL;
