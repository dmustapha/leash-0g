-- SE-7 (SE-5 Gate-② carry #3): the generic chained append now threads the
-- agent's chain_id into every trace row (subquery-derived from the agents row,
-- never caller text — store/chained.ts). Migration 020 backfilled the historic
-- rows; with the append populating new rows, the column can become a hard
-- guarantee + get its chain-scoped audit-read index.
-- search_path is set by the runner (public / ephemeral test schema).

UPDATE trace_records tr SET chain_id = a.chain_id
  FROM agents a WHERE tr.agent_id = a.id AND tr.chain_id IS NULL;
ALTER TABLE trace_records ALTER COLUMN chain_id SET NOT NULL;
CREATE INDEX trace_records_chain_agent ON trace_records (chain_id, agent_id);
