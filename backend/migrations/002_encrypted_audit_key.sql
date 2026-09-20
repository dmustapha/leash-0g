-- Opaque KEK-wrapped audit privkey blob (spec §5 keys): encrypted CLIENT-SIDE
-- in the owner's browser (wallet-signature or passphrase KEK) and stored blind
-- — the server cannot open it. Returned on GET /api/agents/:id so the audit
-- page can offer decrypt-in-browser without the backup file.
ALTER TABLE agents ADD COLUMN encrypted_audit_key text;
