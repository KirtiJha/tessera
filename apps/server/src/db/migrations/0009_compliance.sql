-- Audit log streaming to a SIEM, and erasure of a person's data.
CREATE TABLE audit_streams (
  org_id           uuid PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  url_enc          text NOT NULL,
  header_name      text,
  header_value_enc text,
  format           text NOT NULL,                -- ndjson | splunk_hec | json_array
  enabled          boolean NOT NULL DEFAULT true,
  cursor           bigint NOT NULL DEFAULT 0,    -- last audit_log.id delivered
  last_sent_at     timestamptz,
  last_error       text,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN erased_at timestamptz;
