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

-- (security L-03) The uniqueness below indexes raw values, so canonical
-- (lowercase) storage must be a DB-level guarantee too — not an application
-- convention a future insert path could silently defeat.
ALTER TABLE agents ADD CONSTRAINT agents_owner_addr_lowercase CHECK (owner_addr = lower(owner_addr));
ALTER TABLE agents ADD CONSTRAINT agents_account_addr_lowercase CHECK (account_addr = lower(account_addr));

-- (code-review W3) Deterministic failure with the offending rows surfaced —
-- the old reads tolerated duplicates (ORDER BY … LIMIT 1), so a pre-existing
-- duplicate must abort THIS migration legibly, never as an opaque index error.
-- (Verified zero duplicates on the live DB before landing this migration.)
DO $$
DECLARE dup record;
BEGIN
  FOR dup IN
    SELECT owner_addr, chain_id, account_addr, count(*) AS n
      FROM agents GROUP BY 1, 2, 3 HAVING count(*) > 1
  LOOP
    RAISE EXCEPTION 'migration 021 blocked: % agents share (owner %, chain %, account %) — resolve before the unique index',
      dup.n, dup.owner_addr, dup.chain_id, dup.account_addr;
  END LOOP;
END $$;

CREATE UNIQUE INDEX agents_owner_chain_account
  ON agents (owner_addr, chain_id, account_addr);
