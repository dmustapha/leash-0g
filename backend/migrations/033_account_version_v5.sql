-- RH2 (V5 migration, A1): allow account_version=5 on the agents table. Migration
-- 018 pinned the CHECK to (2, 4); the governed-signing V5 account (Stage F′, FP-4)
-- added its init_code_hash column (028) but never widened this constraint, so a V5
-- agent row could not be persisted through the create funnel. The trader/oracleBand
-- lane now mints V5 (so the swap wall budgets amountIn + pins the recipient,
-- closing SCOPE-RH2-1), so the read-model must accept it. Additive: 2 and 4 stay
-- valid (legacy + governed-calldata).

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_account_version_chk;
ALTER TABLE agents ADD CONSTRAINT agents_account_version_chk CHECK (account_version IN (2, 4, 5));
