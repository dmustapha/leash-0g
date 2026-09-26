-- LEASH Phase 5.5 (Conversational Direction) schema. search_path is set by the
-- runner (production: public; tests: an ephemeral schema).

-- directions (spec §5): the conversational-direction read-back thread + lifecycle.
-- `draft` is a QUARANTINED DirectionDraft (a suggestion; holds no armed authority).
-- Authority is written ONLY by the owner's confirm, which appends an ordered,
-- hash-chained `direction` consent record to trace_records. This table is working
-- state (status transitions draft -> confirmed -> applied, or -> superseded/expired),
-- NOT the proof surface, so it is intentionally mutable.
CREATE TABLE directions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     uuid NOT NULL REFERENCES agents(id),
  owner_addr   text NOT NULL,
  intent       text NOT NULL,
  answers      jsonb,
  draft        jsonb NOT NULL,
  -- The owner-confirmed EFFECTIVE goal (goalPatch merged + owner-typed recipient
  -- re-target), computed + R-1-validated at confirm; null while `draft`. The
  -- runtime sense_direction step re-validates and writes it to agents.goal.
  effective_goal jsonb,
  status       text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','confirmed','applied','expired','superseded')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  applied_at   timestamptz
);
CREATE INDEX directions_agent_status ON directions (agent_id, status);

-- agent_memory (spec §5, S23): a thin per-agent working-memory log that powers the
-- conversational "what've you got so far?" status query. Content is AGENT-AUTHORED
-- => QUARANTINED-UNTRUSTED (the read-only status summary reads it but is never
-- authority). A bounded rolling window: entries are never MODIFIED in place, and
-- the oldest are pruned by the writer to cap the window.
CREATE TABLE agent_memory (
  agent_id   uuid NOT NULL REFERENCES agents(id),
  seq        bigint NOT NULL,
  ts         timestamptz NOT NULL,
  kind       text NOT NULL,
  content    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, seq)
);

-- Written content is immutable (no in-place tampering of a quarantined record).
-- DELETE is permitted so the writer can prune the rolling window; UPDATE is not.
CREATE FUNCTION forbid_agent_memory_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'agent_memory content is immutable (append-only)';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_memory_no_update
  BEFORE UPDATE ON agent_memory
  FOR EACH ROW EXECUTE FUNCTION forbid_agent_memory_update();
