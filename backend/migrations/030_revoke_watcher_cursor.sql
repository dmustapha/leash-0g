-- DM-9: the Revoked-event watcher cursor must be DURABLE. The in-memory
-- lastBlock was re-seeded to the chain head on every (re)start, SKIPPING every
-- Revoked emitted while the process was down = revoked-on-chain-but-still-
-- looping (the fail-open the product forbids). It was also reorg-blind
-- (head <= lastBlock swallowed a backwards head with no rewind).
--
-- One row per watched chain_id; the watcher persists the highest fully-scanned
-- block after each successful tick and resumes from it (rewound by a small
-- reorg margin) on boot. search_path is set by the runner (public / ephemeral
-- test schema).

CREATE TABLE revoke_watcher_cursor (
  chain_id   integer     PRIMARY KEY,
  last_block bigint      NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
