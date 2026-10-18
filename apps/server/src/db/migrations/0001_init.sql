-- Tessera schema, migration 0001.
-- Every tenant-scoped table carries org_id; session ids come from reporters, so
-- they are unique only within an org and every session-keyed table is keyed by
-- (org_id, session_id).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE orgs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE teams (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name        text NOT NULL,
  slug        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);

CREATE TYPE user_role AS ENUM ('owner', 'admin', 'approver', 'operator', 'viewer');
CREATE TYPE user_status AS ENUM ('active', 'invited', 'disabled');

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  team_id        uuid REFERENCES teams(id) ON DELETE SET NULL,
  email          text NOT NULL,
  name           text NOT NULL,
  password_hash  text,
  role           user_role NOT NULL DEFAULT 'operator',
  status         user_status NOT NULL DEFAULT 'active',
  invite_token_hash text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz,
  UNIQUE (org_id, email)
);
CREATE UNIQUE INDEX users_email_global ON users (lower(email));

CREATE TABLE user_sessions (
  id           text PRIMARY KEY,            -- sha256 of the cookie token
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ip           text,
  user_agent   text
);
CREATE INDEX user_sessions_user ON user_sessions (user_id);

CREATE TABLE devices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label         text NOT NULL,
  hostname      text,
  machine_id    text,
  token_hash    text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX devices_user ON devices (user_id);

CREATE TABLE enrolment_codes (
  code        text PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  device_id   uuid REFERENCES devices(id) ON DELETE SET NULL
);

CREATE TYPE session_status AS ENUM ('running', 'waiting', 'idle', 'ended');

CREATE TABLE sessions (
  org_id           uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  id               text NOT NULL,
  team_id          uuid REFERENCES teams(id) ON DELETE SET NULL,
  owner_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  device_id        uuid REFERENCES devices(id) ON DELETE SET NULL,
  name             text,
  reporter_kind    text NOT NULL,
  reporter_version text NOT NULL,
  hostname         text,
  machine_id       text,
  cwd              text,
  model            text,
  effort           text,
  status           session_status NOT NULL,
  wait_reason      text,
  started_at       timestamptz NOT NULL,
  ended_at         timestamptz,
  end_reason       text,
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  dropped_at       timestamptz,
  context_used     bigint,
  context_window   bigint,
  tokens           jsonb NOT NULL DEFAULT '{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}'::jsonb,
  usage_by_model   jsonb NOT NULL DEFAULT '[]'::jsonb,
  ledger_cost_usd  numeric(14,6),
  blowouts         integer NOT NULL DEFAULT 0,
  git              jsonb,
  files_changed    jsonb NOT NULL DEFAULT '[]'::jsonb,
  plan             jsonb,
  open_ask         jsonb,
  tags             jsonb NOT NULL DEFAULT '{}'::jsonb,
  continued_from   text,
  control          jsonb NOT NULL DEFAULT '{"paused":false,"reason":null,"by":null}'::jsonb,
  PRIMARY KEY (org_id, id)
);
CREATE INDEX sessions_live ON sessions (org_id, last_seen_at DESC) WHERE ended_at IS NULL AND dropped_at IS NULL;
CREATE INDEX sessions_history ON sessions (org_id, started_at DESC);
CREATE INDEX sessions_owner ON sessions (owner_id, started_at DESC);

CREATE TABLE agents (
  org_id          uuid NOT NULL,
  session_id      text NOT NULL,
  id              text NOT NULL,
  parent_id       text,
  kind            text NOT NULL,
  type            text,
  description     text,
  model           text,
  effort          text,
  status          text NOT NULL,
  started_at      timestamptz NOT NULL,
  ended_at        timestamptz,
  tokens          jsonb NOT NULL,
  usage_by_model  jsonb NOT NULL DEFAULT '[]'::jsonb,
  context         jsonb,
  tool_calls      jsonb NOT NULL DEFAULT '{}'::jsonb,
  skills          jsonb NOT NULL DEFAULT '[]'::jsonb,
  failure         jsonb,
  prompt_excerpt  text,
  answer_excerpt  text,
  PRIMARY KEY (org_id, session_id, id),
  FOREIGN KEY (org_id, session_id) REFERENCES sessions(org_id, id) ON DELETE CASCADE
);

CREATE TABLE events (
  org_id      uuid NOT NULL,
  session_id  text NOT NULL,
  id          text NOT NULL,
  ts          timestamptz NOT NULL,
  kind        text NOT NULL,
  agent_id    text,
  text        text NOT NULL,
  data        jsonb,
  PRIMARY KEY (org_id, session_id, id),
  FOREIGN KEY (org_id, session_id) REFERENCES sessions(org_id, id) ON DELETE CASCADE
);
CREATE INDEX events_recent ON events (org_id, ts DESC);

CREATE TABLE samples (
  org_id        uuid NOT NULL,
  session_id    text NOT NULL,
  ts            timestamptz NOT NULL,
  tokens_total  bigint NOT NULL,
  tokens_delta  bigint NOT NULL,
  cost_usd      numeric(14,6),
  usage_by_model jsonb,
  PRIMARY KEY (org_id, session_id, ts),
  FOREIGN KEY (org_id, session_id) REFERENCES sessions(org_id, id) ON DELETE CASCADE
);
CREATE INDEX samples_recent ON samples (org_id, ts DESC);

CREATE TABLE asks (
  id           text NOT NULL,
  org_id       uuid NOT NULL,
  session_id   text NOT NULL,
  kind         text NOT NULL,
  tool         text,
  prompt       text NOT NULL,
  options      jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at   timestamptz NOT NULL,
  closed_at    timestamptz,
  answered_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  answer       jsonb,
  outcome      text,
  PRIMARY KEY (org_id, session_id, id),
  FOREIGN KEY (org_id, session_id) REFERENCES sessions(org_id, id) ON DELETE CASCADE
);

CREATE TABLE deliveries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  session_id    text NOT NULL,
  kind          text NOT NULL,            -- answer | message | command
  ask_id        text,
  payload       jsonb NOT NULL,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  delivered_at  timestamptz,
  result        jsonb,
  result_at     timestamptz,
  FOREIGN KEY (org_id, session_id) REFERENCES sessions(org_id, id) ON DELETE CASCADE
);
CREATE INDEX deliveries_pending ON deliveries (org_id, session_id) WHERE delivered_at IS NULL;

CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  actor_id     uuid,
  actor_name   text NOT NULL,
  action       text NOT NULL,
  target_type  text,
  target_id    text,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip           text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  prev_hash    text,
  hash         text NOT NULL
);
CREATE INDEX audit_org ON audit_log (org_id, id DESC);

CREATE TABLE budgets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  scope_type   text NOT NULL,              -- org | team | user
  scope_id     uuid,
  "window"     text NOT NULL,              -- daily | weekly | monthly
  soft_usd     numeric(14,2),
  hard_usd     numeric(14,2),
  enforce      boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (org_id, scope_type, scope_id, "window")
);

CREATE TABLE budget_breaches (
  id           bigserial PRIMARY KEY,
  org_id       uuid NOT NULL,
  budget_id    uuid NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  level        text NOT NULL,              -- soft | hard
  window_start timestamptz NOT NULL,
  spent_usd    numeric(14,6) NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (budget_id, level, window_start)
);

CREATE TABLE model_prices (
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  prefix       text NOT NULL,
  label        text NOT NULL,
  input        numeric(12,6) NOT NULL,
  output       numeric(12,6) NOT NULL,
  cache_read   numeric(12,6) NOT NULL,
  cache_write  numeric(12,6) NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, prefix)
);

CREATE TABLE notification_channels (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  kind        text NOT NULL,               -- slack_webhook | webhook
  name        text NOT NULL,
  url_enc     text NOT NULL,               -- encrypted with the server secret
  events      jsonb NOT NULL DEFAULT '["session.waiting","agent.failed","budget.breach","context.blowout"]'::jsonb,
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_sent_at timestamptz,
  last_error  text
);

CREATE TABLE notification_log (
  id          bigserial PRIMARY KEY,
  org_id      uuid NOT NULL,
  channel_id  uuid NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
  event       text NOT NULL,
  dedupe_key  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, dedupe_key)
);
