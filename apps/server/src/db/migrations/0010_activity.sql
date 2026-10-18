-- The most recent tool calls of a session, so the wall shows what it is doing now
-- and an approver sees what led to a prompt. Bounded (40) and rewritten whole.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS activity jsonb NOT NULL DEFAULT '[]'::jsonb;
