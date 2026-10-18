-- Cost allocation and analytics.

-- A team's cost centre, for chargeback.
ALTER TABLE teams ADD COLUMN cost_center text;

-- Cost and tokens per session per UTC day, rolled up from the per-minute samples.
-- Samples are pruned after a month; this keeps spend history for as long as the session.
CREATE TABLE usage_daily (
  org_id      uuid NOT NULL,
  session_id  text NOT NULL,
  day         date NOT NULL,
  tokens      bigint NOT NULL,
  cost_usd    numeric(14,6) NOT NULL,
  PRIMARY KEY (org_id, session_id, day),
  FOREIGN KEY (org_id, session_id) REFERENCES sessions(org_id, id) ON DELETE CASCADE
);
CREATE INDEX usage_daily_org_day ON usage_daily (org_id, day);
