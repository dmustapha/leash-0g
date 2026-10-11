-- SCOPE-I-6: unbounded-growth prune for the append-only audit streams.
-- trace_records / owner_records are append-only (forbid_trace_mutation trigger)
-- and never pruned, so they grow forever in Postgres even though the durable
-- copy lives on 0G Storage once a batch is flushed. The OPERATOR prune
-- (scripts/prune-audit.mjs) deletes rows already archived to 0G + older than a
-- retention window — but pruning the chain PREFIX would break full
-- verification (verifyChain reads from seq 0 and expects GENESIS). This table
-- is the durable CHECKPOINT that anchors the retained suffix: the last pruned
-- (seq, hash) per stream+key. Full verification resumes from checkpoint.seq+1
-- expecting checkpoint.hash instead of genesis. Written atomically in the SAME
-- txn as the delete (never a delete without an anchor). search_path set by the
-- runner (public / ephemeral test schema). No backfill — unpruned streams have
-- no checkpoint and verify from genesis as before.
CREATE TABLE audit_prune_checkpoint (
  stream             text        NOT NULL,          -- 'trace' | 'owner'
  key                text        NOT NULL,          -- agent_id | owner_addr
  pruned_through_seq  bigint      NOT NULL,
  pruned_through_hash text        NOT NULL,
  pruned_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (stream, key)
);
