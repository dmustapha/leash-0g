-- Phase 2 coordination tables (spec §5 DDL). Schema-qualification is
-- intentionally absent: the runner sets search_path (production: public;
-- tests: an ephemeral schema).
--
-- Generality guard (spec §1): kind/payload are OPAQUE to the platform — no
-- treasury-specific columns here, ever. Links are the ONLY authorization for
-- delegation (no link, no handoff); ids are supplied by the app (single-use
-- envelope ids, spec §6).

CREATE TABLE links (
  id uuid PRIMARY KEY, owner_addr text NOT NULL,
  from_agent_id uuid NOT NULL REFERENCES agents(id),
  to_agent_id   uuid NOT NULL REFERENCES agents(id),
  mode   text NOT NULL CHECK (mode IN ('auto','supervised')),
  status text NOT NULL CHECK (status IN ('active','paused','removed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (from_agent_id, to_agent_id), CHECK (from_agent_id <> to_agent_id)
);

CREATE TABLE delegations (
  id uuid PRIMARY KEY, link_id uuid NOT NULL REFERENCES links(id),
  from_agent_id uuid NOT NULL REFERENCES agents(id),
  to_agent_id   uuid NOT NULL REFERENCES agents(id),
  kind text NOT NULL, payload jsonb NOT NULL,          -- opaque (generality guard)
  status text NOT NULL CHECK (status IN ('pending_approval','pending','accepted',
    'completed','failed','declined','cancelled','expired')),
  result jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz, expires_at timestamptz NOT NULL
);

CREATE INDEX ON delegations (to_agent_id, status);
CREATE INDEX ON delegations (link_id, created_at DESC);
