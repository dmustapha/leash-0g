-- Phase 5.6 (Agent chaining across capabilities, spec §5): the `chains`
-- read-model projection. Like the Phase-4 `jobs` projection (011), this is
-- RUNTIME state, NOT authority — it threads chainId/hopIndex over the EXISTING
-- links/delegations and confers NO goal/policy/spend. The coordination tables
-- (links/delegations) stay generic (generality guard): a chain hop rides the
-- opaque `chain.handoff` delegation kind, interpreted only in the runtime graph.
--
-- search_path is set by the runner (production: public; tests: an ephemeral
-- schema) — schema-qualification is intentionally absent.

CREATE TABLE chains (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_addr     text NOT NULL,
  origin_agent_id uuid NOT NULL REFERENCES agents(id),
  direction_id   uuid NOT NULL REFERENCES directions(id),
  -- The owner-authored, ordered chain plan (ChainStep[]) — QUARANTINED: it is a
  -- suggestion object, holds NO armed authority. depth = jsonb_array_length(plan).
  plan           jsonb NOT NULL,
  status         text NOT NULL DEFAULT 'planned'
                   CHECK (status IN ('planned','running','completed','terminated')),
  -- next hop the runtime will propose (0-based). Advanced by CAS at propose /
  -- settle time so a hop is proposed exactly once (idempotent, D-2/§3b).
  next_hop       int NOT NULL DEFAULT 0,
  -- The realised chain PATH: origin + each SELECTED target so far, in order.
  -- Used for the runtime cycle-prevention re-check at propose time (D-4) — an
  -- agent may appear at most once in a chain path.
  path           jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The delegation id of the currently in-flight hop (null when none). Threads
  -- the chain-ordered view; onHopSettled matches a settled delegation to its chain.
  current_delegation_id uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX chains_owner ON chains (owner_addr, created_at DESC);
CREATE INDEX chains_origin ON chains (origin_agent_id);
-- Fast lookup from a settled hop delegation back to its chain (onHopSettled).
CREATE INDEX chains_current_delegation ON chains (current_delegation_id)
  WHERE current_delegation_id IS NOT NULL;
