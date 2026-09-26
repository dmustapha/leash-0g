-- LEASH Phase 5.5 (round-2 H-01 complete fix): a DURABLE ledger of owner-triggered
-- 0G Compute calls (elevate / direct / status) so the global rate ceiling that
-- bounds LEASH's shared Compute key survives process restarts AND holds across
-- instances (the in-process counter did neither). One tiny row per call; rows
-- older than the window are pruned on each check, so the table stays ~1h-bounded.
CREATE TABLE llm_call_log (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX llm_call_log_ts ON llm_call_log (ts);
