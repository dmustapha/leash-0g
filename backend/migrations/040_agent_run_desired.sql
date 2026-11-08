-- AQ-FND S1 (WP-F, review blocker B-2): remember which agents the OWNER wants running, so a backend
-- restart (every deploy!) resumes them instead of silently stopping every agent.
--   true  : owner pressed Start (or create auto-started a spend-incapable role)
--   false : owner stopped / revoked / the loop-breaker paused it (default: never auto-start)
-- Additive; existing rows default to false (owners press Resume once after the first deploy).
ALTER TABLE agents ADD COLUMN IF NOT EXISTS run_desired boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS agents_run_desired ON agents (run_desired) WHERE run_desired;
