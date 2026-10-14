-- NC-2 (tear-apart): audit/stream pubkey rotation was owner-authenticated by
-- Privy SESSION only (access-control), not by an owner EVM SIGNATURE (crypto).
-- A forged/stolen session or a DB-admin could repoint FUTURE audit batches to
-- an attacker's pubkey, leaking forward audit confidentiality. The rotation
-- routes now require an owner EIP-712 signature verified by ecrecover.
--
-- This table is the per-(owner, target) monotonic REPLAY GUARD: each signed
-- SetAuditPubkey carries a `nonce`; a rotation is accepted only when
-- nonce > last_nonce, and last_nonce is advanced in the SAME txn as the key
-- write. `target` is the agent_id for the agent route or the literal
-- 'owner-stream' for the owner-stream routes. No backfill — an absent row means
-- last_nonce = -1, so the first signed rotation (nonce >= 0) is accepted.
-- search_path is set by the runner (public / ephemeral test schema).
CREATE TABLE audit_pubkey_rotation_nonce (
  owner_addr  text        NOT NULL,
  target      text        NOT NULL,
  last_nonce  numeric(78,0) NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_addr, target)
);
