-- SE-6 pre-req (retargeted SE-5 Gate-② carry #1): under CREATE2, TWO DIFFERENT
-- OWNERS can deterministically hold the SAME account address on the same chain
-- (the address is f(owner, salt) only when the full construction tuple matches —
-- but nothing DB-level prevented a colliding row before this migration). Two
-- guarantees land here:
--   1. UNIQUE(owner_addr, chain_id, account_addr) — within an owner, a
--      (chain, account) pair maps to AT MOST one agent row, so address-keyed
--      reads never need an arbitrary ORDER BY … LIMIT 1 pick; the uniqueness
--      is a DB-level impossibility-of-collision, not an unindexed convention.
--      (Cross-OWNER same-address rows remain legal — that is exactly the CREATE2
--      collision case — and are partitioned by the owner_addr key + owner-scoped
--      reads in store/agents.ts / store/capabilities.ts.)
--   2. agents.account_salt — the per-agent CREATE2 salt (server-generated at a
--      deterministic v4 create, reused verbatim on every chain the agent onboards
--      so the account lands at the SAME address). Nullable: legacy v2/v3 + plain
--      (pre-deterministic) v4 accounts have none.
-- search_path is set by the runner (public / ephemeral test schema).

ALTER TABLE agents ADD COLUMN account_salt text;

CREATE UNIQUE INDEX agents_owner_chain_account
  ON agents (owner_addr, chain_id, account_addr);
