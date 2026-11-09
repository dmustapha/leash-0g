-- AQ-FND S1 (review R3-7): the model-ROUTER outage class ('upstream') as a NEW migration instead of an edit of 041, so a
-- database that already applied 041 gets the wider CHECK too. A router blip is infrastructure, not the agent's reasoning
-- failing: it trips only after 20 consecutive cycles (see typed-breakers.ts).
ALTER TABLE agent_breakers DROP CONSTRAINT IF EXISTS agent_breakers_class_check;
ALTER TABLE agent_breakers ADD CONSTRAINT agent_breakers_class_check CHECK (class IN ('permanent', 'transient', 'model', 'ambiguous', 'upstream'));
