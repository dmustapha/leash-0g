-- SE-1 (Stage E): persist the on-chain account version per agent so the runtime /
-- read-model know which factory bytecode + ABI surface an agent's account has.
-- Additive + backfilled: every existing row was created via the legacy factory
-- (createAccount → v2/v3 bytecode), so backfill to 2. New governed-calldata
-- agents are minted V4 (default 4 at the create funnel, SD-E7). Legacy path stays
-- reachable via accountVersion:2 (E-1 regression).
-- NOTE: DEFAULT 2 is BACKFILL-ONLY (existing rows are all legacy). Live inserts
-- ALWAYS pass account_version explicitly (insertAgent → funnel default 4), so a
-- new agent never silently defaults to legacy; the DEFAULT only serves the
-- one-time column backfill.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS account_version smallint NOT NULL DEFAULT 2;

-- Guard: only the two shipped versions are valid (v2/v3 share the legacy factory
-- bytecode + are recorded as 2; v4 is the governed-calldata account).
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_account_version_chk;
ALTER TABLE agents ADD CONSTRAINT agents_account_version_chk CHECK (account_version IN (2, 4));
