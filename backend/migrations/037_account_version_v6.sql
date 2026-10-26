-- AQ-FND Lane-B (the v6 default flip): allow account_version=6 on the agents table.
-- Migration 033 widened the CHECK to (2, 4, 5) for the V5 trader lane; the AQ-FND
-- multi-asset LeashAccountV6 is now the chain default wherever the five V6
-- singletons are wired, so the read-model must accept it. Additive: 2/4/5 stay
-- valid (legacy + governed-calldata + governed-signing).

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_account_version_chk;
ALTER TABLE agents ADD CONSTRAINT agents_account_version_chk CHECK (account_version IN (2, 4, 5, 6));
