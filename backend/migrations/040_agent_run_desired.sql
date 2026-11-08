-- AQ-FND S1 (WP-F, review blocker B-2): remember which agents the OWNER wants running, so a backend
-- restart (every deploy!) resumes them instead of silently stopping every agent.
--   true  : owner pressed Start (or create auto-started a spend-incapable role)
--   false : owner stopped / revoked / the loop-breaker paused it (default: never auto-start)
-- Additive; existing rows default to false (owners press Resume once after the first deploy).
ALTER TABLE agents ADD COLUMN IF NOT EXISTS run_desired boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS agents_run_desired ON agents (run_desired) WHERE run_desired;

-- One-time backfill at first apply (review m-8): agents that were visibly RUNNING just before this deploy
-- (a trace record in the last 15 minutes) keep running after the restart that applies this migration, instead of
-- being silently stopped. Agents the owner stopped earlier have no recent trace and stay stopped.
UPDATE agents SET run_desired = true
 WHERE status = 'active' AND bind_mode IS DISTINCT FROM 'external'
   AND id IN (SELECT DISTINCT agent_id FROM trace_records WHERE created_at > now() - interval '15 minutes');
