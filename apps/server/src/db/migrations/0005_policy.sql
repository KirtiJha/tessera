-- Tool-call policy: every save is a new version; the highest version is in force.
CREATE TABLE policy_versions (
  org_id          uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  version         integer NOT NULL,
  rules           jsonb NOT NULL,
  note            text,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_name text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, version)
);

-- Calls a rule denied, sent for approval, or (dry run) would have.
CREATE TABLE policy_decisions (
  id          bigserial PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  session_id  text NOT NULL,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  tool        text NOT NULL,
  summary     text,
  rule_id     text NOT NULL,
  rule_name   text NOT NULL,
  effect      text NOT NULL,
  enforced    boolean NOT NULL,
  version     integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX policy_decisions_org_time ON policy_decisions (org_id, created_at DESC);
