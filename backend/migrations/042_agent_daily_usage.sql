-- AQ-FND S1 (WP-F hard budgets): a per-agent, per-UTC-day count of model calls, so a runaway loop can never
-- spend without bound. The cap itself is config (RUNTIME_MODEL_CALLS_PER_AGENT_PER_DAY); this is only the counter.
CREATE TABLE agent_daily_usage (
  agent_id    text NOT NULL,
  day         date NOT NULL,
  model_calls integer NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, day)
);
