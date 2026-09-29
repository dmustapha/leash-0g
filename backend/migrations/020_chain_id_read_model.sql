-- SE-5 (Stage E, E-5): the multichain read-model key. Every agent is pinned to a
-- chain, and the capability read-model (grants / presets / JIT requests) is keyed
-- by (chainId, account) so a call / one-shot / policy read on chain A can never
-- resolve chain B's grant state — the cross-chain state-confusion guard (spec §8).
-- Additive + backfilled: all existing rows are on 0G Galileo (chainId 16602).
--
-- `agents.chain_id` is the AUTHORITATIVE anchor: (chain_id, account_addr) uniquely
-- identifies an account even under SE-6 CREATE2 same-address. The capability rows
-- carry a DENORMALIZED chain_id derived from their agent at write time (subquery),
-- so chain-scoped reads never need a join and the isolation guarantee is local to
-- each row. search_path is set by the runner (public / ephemeral test schema).

-- Agents: the chain anchor. Backfill existing → 0G, then require it.
ALTER TABLE agents ADD COLUMN chain_id bigint;
UPDATE agents SET chain_id = 16602 WHERE chain_id IS NULL;
ALTER TABLE agents ALTER COLUMN chain_id SET NOT NULL;
-- (chain_id, account_addr) is the effective account key — the isolation index.
CREATE INDEX agents_chain_account ON agents (chain_id, account_addr);

-- Capability grants (on-chain CallRule mirror). Derive chain from the agent.
ALTER TABLE capability_grants ADD COLUMN chain_id bigint;
UPDATE capability_grants cg SET chain_id = a.chain_id FROM agents a WHERE cg.agent_id = a.id AND cg.chain_id IS NULL;
ALTER TABLE capability_grants ALTER COLUMN chain_id SET NOT NULL;
CREATE INDEX capability_grants_chain ON capability_grants (chain_id, agent_id);

-- Capability presets (applied preset sugar). Derive chain from the agent.
ALTER TABLE capability_presets ADD COLUMN chain_id bigint;
UPDATE capability_presets cp SET chain_id = a.chain_id FROM agents a WHERE cp.agent_id = a.id AND cp.chain_id IS NULL;
ALTER TABLE capability_presets ALTER COLUMN chain_id SET NOT NULL;
CREATE INDEX capability_presets_chain ON capability_presets (chain_id, agent_id);

-- Capability JIT requests (the L2 grant workflow). Derive chain from the agent.
ALTER TABLE capability_requests ADD COLUMN chain_id bigint;
UPDATE capability_requests cr SET chain_id = a.chain_id FROM agents a WHERE cr.agent_id = a.id AND cr.chain_id IS NULL;
ALTER TABLE capability_requests ALTER COLUMN chain_id SET NOT NULL;
CREATE INDEX capability_requests_chain ON capability_requests (chain_id, agent_id, created_at DESC);

-- Trace records: agent_id-scoped, so cross-chain isolation is already inherent
-- (an agent belongs to exactly one chain). chain_id is added DENORMALIZED for
-- chain-scoped audit reads + parity with the read-model; nullable + backfilled
-- (the generic hash-chained append path threads it in SE-7 with the first real
-- 2nd chain — until then every trace is 0G and derivable via agents.chain_id).
ALTER TABLE trace_records ADD COLUMN chain_id bigint;
UPDATE trace_records tr SET chain_id = a.chain_id FROM agents a WHERE tr.agent_id = a.id AND tr.chain_id IS NULL;
