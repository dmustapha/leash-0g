-- SE-6 (code-review W2): the CREATE2 address is f(factory, owner, salt, FULL
-- construction tuple) — persisting only the salt is not enough to re-onboard an
-- agent onto a second chain at the SAME address, because the tuple cannot be
-- reconstructed later (policy/expiry are time-derived at create and mutable
-- on-chain afterwards). Persist the EXACT canonical tuple the v4 mint used
-- (server-authored, from the deploy result — never caller/model text) so a
-- future chain onboard (SE-7/SE-8) replays it verbatim and assertSameAddress
-- verifies instead of refusing a self-inflicted divergence.
-- Nullable: legacy v2/v3 + pre-SE-6 v4 accounts have none.

ALTER TABLE agents ADD COLUMN account_create_tuple jsonb;
