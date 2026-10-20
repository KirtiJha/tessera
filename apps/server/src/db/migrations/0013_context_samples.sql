-- How full the session's context window was in each minute, for the context timeline.
ALTER TABLE samples ADD COLUMN IF NOT EXISTS context_used integer;
ALTER TABLE samples ADD COLUMN IF NOT EXISTS context_window integer;
