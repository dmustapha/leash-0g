-- Runtime copy of the agent's gateway bearer token, AES-256-GCM under
-- KEY_ENCRYPTION_SECRET (same custody class as session_key_enc: a scoped
-- credential the co-located runtime needs at start; spec §3b "the runtime
-- holds ONLY the agent's scoped session key + gateway token"). The gateway
-- itself still verifies only the argon2id token_hash.
ALTER TABLE agents ADD COLUMN gateway_token_enc text;
