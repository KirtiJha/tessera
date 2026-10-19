-- The session's own tool calls per tool (the orchestrator's), beside each agent's,
-- so the tool mix an organisation sees covers the whole session and not only its agents.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS tool_calls jsonb NOT NULL DEFAULT '{}'::jsonb;
