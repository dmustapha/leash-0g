-- C-1 (Phase 2): dedicated guardian KEY lane. Each account records which
-- guardian address it was created with so the revoke path picks the matching
-- signing key. NULL = legacy Phase-1 account (old ops-key guardian) until the
-- startup backfill writes the ops address explicitly (src/index.ts) — the
-- ops address is config, so the backfill cannot live in static SQL.
ALTER TABLE agents ADD COLUMN guardian_addr text;
