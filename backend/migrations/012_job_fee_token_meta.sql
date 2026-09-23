-- Asset-aware settlement display (D-JOB-10 follow-up): the settlement surfaces
-- must DETECT + label the true asset (native 0G vs USDC/TestUSD) instead of
-- assuming 0G. These columns hold the ERC-20 symbol + decimals, read on-chain
-- once at originate. Added as a SEPARATE migration because 011 was already
-- applied on the live DB (the forward-only runner never re-runs an edited file).
-- Idempotent so it is a no-op on fresh DBs where 011 already defines the columns.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS fee_token_symbol text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS fee_token_decimals int;

-- Ensure the settlement claim state ('settling', H-01 double-settle guard) is a
-- permitted status on any DB whose 011 predates it. Rebuild the CHECK safely.
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check CHECK (status IN (
  'originated','delivered','evaluating','verdict','awaiting_approval',
  'settling','settled','rejected','denied','failed'));
