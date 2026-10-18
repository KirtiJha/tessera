-- Indexes for the per-org KPI queries, which otherwise scan every agent and
-- every event of the day.
CREATE INDEX IF NOT EXISTS agents_failed_recent ON agents (org_id, ended_at DESC) WHERE status = 'failed';
CREATE INDEX IF NOT EXISTS events_blowouts ON events (org_id, ts DESC) WHERE kind = 'context.blowout';
-- Samples are now one row per session per minute; this index serves the
-- per-session series on the session page.
CREATE INDEX IF NOT EXISTS samples_session_recent ON samples (org_id, session_id, ts DESC);
