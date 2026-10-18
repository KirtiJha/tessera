-- Act from chat: Slack app channels with buttons, Teams, PagerDuty, signed webhooks,
-- and channels that wait before they notify.

ALTER TABLE notification_channels ALTER COLUMN url_enc DROP NOT NULL;
-- Kind-specific secrets as encrypted JSON: slack_app {botToken, signingSecret, channel},
-- pagerduty {routingKey}, webhook {signingSecret}.
ALTER TABLE notification_channels ADD COLUMN secret_enc text;
-- Only notify about a waiting session once it has waited this long (escalation channels).
ALTER TABLE notification_channels ADD COLUMN delay_s integer NOT NULL DEFAULT 0 CHECK (delay_s BETWEEN 0 AND 86400);

-- Where a sent notification lives on the other side (Slack channel and ts, PagerDuty
-- dedup key), so it can be updated or resolved when the session moves on.
ALTER TABLE notification_log ADD COLUMN external_ref jsonb;
ALTER TABLE notification_log ADD COLUMN resolved_at timestamptz;
CREATE INDEX notification_log_open ON notification_log (org_id, dedupe_key) WHERE resolved_at IS NULL;

-- A Slack user, matched to a Tessera user by verified email the first time they press a button.
CREATE TABLE slack_user_links (
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  slack_team  text NOT NULL,
  slack_user  text NOT NULL,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, slack_team, slack_user)
);
