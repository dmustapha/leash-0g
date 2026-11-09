-- AQ-FND S1 (WP-F): PERSISTED, TYPED failure counters per agent (the E1 loop-breaker lived in memory,
-- reset on every restart and never counted a failed on-chain send). One row per (agent, class):
--   permanent : the wall refused it on its merits (a retry cannot help)            -> trips fast
--   transient : RPC / timeout / router trouble                                      -> trips slow
--   model     : unparsable output, refusal, truncated (finish_reason=length), loop -> never "retry with more tokens"
--   ambiguous : unknown tx state (nonce consumed by something else)                -> trips at once
-- transient/model are CONSECUTIVE counters (a healthy cycle resets them); permanent decays by time.
CREATE TABLE agent_breakers (
  agent_id    text NOT NULL,
  class       text NOT NULL CHECK (class IN ('permanent', 'transient', 'model', 'ambiguous')),
  count       integer NOT NULL DEFAULT 0,
  first_at    timestamptz NOT NULL DEFAULT now(),
  last_at     timestamptz NOT NULL DEFAULT now(),
  tripped_at  timestamptz,
  last_detail text,
  PRIMARY KEY (agent_id, class)
);
