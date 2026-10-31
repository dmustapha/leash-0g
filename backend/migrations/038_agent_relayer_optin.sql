-- AQ-FND M-3 (cross-chain gas routing): per-agent owner opt-in for the RELAYER bootstrap.
-- LEASH runs no gas-sponsorship relayer by default (D-4); an owner may explicitly allow the
-- LEASH-ops EIP-7702 bootstrap as a last-resort gas path. Additive, default off: every
-- existing agent keeps today's behaviour.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS allow_relayer_bootstrap boolean NOT NULL DEFAULT false;
