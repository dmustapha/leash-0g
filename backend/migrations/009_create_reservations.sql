-- P3C-1 (Phase 3): per-owner in-flight create guard. A create's agent row only
-- exists AFTER the slow on-chain deploy, so quota/rate checks that count
-- committed rows admit an entire parallel burst at t=0 (Gate-② Phase-2
-- finding). Each create now inserts a reservation row FIRST — under a
-- per-owner advisory lock so the check-and-reserve is itself serialized —
-- and quota/rate count live reservations alongside agents rows.
-- Released (not deleted) on completion/failure so the burst attempt itself
-- stays observable; stale rows are TTL-released by the sweep.
CREATE TABLE create_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_addr text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);

CREATE INDEX create_reservations_live_idx
  ON create_reservations (owner_addr)
  WHERE released_at IS NULL;
