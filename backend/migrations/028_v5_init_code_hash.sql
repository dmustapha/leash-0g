-- Stage F′ (FP-4 P1, RULING-A): persist keccak256 of the EXACT V5 account initcode
-- the CREATE2 deploy ran. The generic Create2Deployer never embeds the account
-- type (so it stays EIP-170-safe), so the account address is f(deployer, salt,
-- keccak256(initcode)) with the initcode assembled OFF-CHAIN by the backend. The
-- cross-chain assertSameAddress compares THIS fixed hash, never a re-derived mutable
-- tuple — a reconstructed tuple (time-derived expiry, reordered allowlist) would
-- hash differently and silently shift the prediction. Nullable: V4/legacy mints
-- predict factory-side and carry none.

ALTER TABLE agents ADD COLUMN init_code_hash text;
