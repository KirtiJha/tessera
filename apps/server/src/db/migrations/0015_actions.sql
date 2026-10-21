-- Every tool call a session made, not only the last 40 its reports carry: the
-- session page pages through them, and the change history reads the edits'
-- patches from here (kept only where the organisation turned that on).
CREATE TABLE IF NOT EXISTS actions (
  org_id      uuid NOT NULL,
  session_id  text NOT NULL,
  id          text NOT NULL,
  ts          timestamptz NOT NULL,
  tool        text NOT NULL,
  agent_id    text,
  summary     text NOT NULL,
  status      text NOT NULL,
  ended_at    timestamptz,
  duration_ms integer,
  error       text,
  withheld    boolean NOT NULL DEFAULT false,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (org_id, session_id, id),
  FOREIGN KEY (org_id, session_id) REFERENCES sessions(org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS actions_by_time ON actions (org_id, session_id, ts DESC);
CREATE INDEX IF NOT EXISTS actions_with_patch ON actions (org_id, session_id, ts) WHERE detail ? 'patch';
