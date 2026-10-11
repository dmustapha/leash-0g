-- SCOPE-RH2-2 / I-6-H2: audit-key ROTATION. Until now the owner-stream pubkey
-- was SET-ONCE (patchOwnerSettings 409'd on a second set) and an agent's
-- audit_pubkey was write-once at register — a lost/compromised audit key could
-- never be rotated, so EVERY future batch encrypted to a dead key.
--
-- Fix: a per-stream KEY HISTORY selected by seq. Each key covers records from
-- its effective_from_seq onward; batches never span a rotation boundary, so
-- every 0G batch maps to exactly one key = deterministic owner read-back (the
-- owner keeps old private keys to decrypt history).
--
-- owner_settings.stream_pubkey and agents.audit_pubkey are KEPT as the
-- "current key" cache + back-compat reads; the history tables below are now
-- the source of truth for flush. search_path is set by the runner.

CREATE TABLE owner_audit_keys (
  owner_addr         text        NOT NULL,
  pubkey             text        NOT NULL,
  effective_from_seq bigint      NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_addr, effective_from_seq)
);

CREATE TABLE agent_audit_keys (
  agent_id           uuid        NOT NULL,
  pubkey             text        NOT NULL,
  effective_from_seq bigint      NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, effective_from_seq)
);

-- Backfill: every existing key covers the whole existing history (seq 0 on).
INSERT INTO owner_audit_keys (owner_addr, pubkey, effective_from_seq)
SELECT owner_addr, stream_pubkey, 0 FROM owner_settings WHERE stream_pubkey IS NOT NULL;

INSERT INTO agent_audit_keys (agent_id, pubkey, effective_from_seq)
SELECT id, audit_pubkey, 0 FROM agents WHERE audit_pubkey IS NOT NULL;
