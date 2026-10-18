-- Domain ownership for single sign-on, proven with a DNS TXT record.
-- Several organisations may claim a domain; only one can verify it, and only a
-- verified domain routes sign-ins or creates accounts.
ALTER TABLE sso_domains ADD COLUMN verification_token text;
ALTER TABLE sso_domains ADD COLUMN verified_at timestamptz;
UPDATE sso_domains SET verification_token = encode(gen_random_bytes(16), 'hex'), verified_at = now();
ALTER TABLE sso_domains ALTER COLUMN verification_token SET NOT NULL;
ALTER TABLE sso_domains DROP CONSTRAINT sso_domains_pkey;
ALTER TABLE sso_domains ADD PRIMARY KEY (org_id, domain);
CREATE UNIQUE INDEX sso_domains_verified ON sso_domains (domain) WHERE verified_at IS NOT NULL;

-- SCIM 2.0 provisioning from the identity provider.
CREATE TABLE scim_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  prefix       text NOT NULL,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX scim_tokens_org ON scim_tokens (org_id) WHERE revoked_at IS NULL;

ALTER TABLE users ADD COLUMN scim_external_id text;
ALTER TABLE users ADD COLUMN given_name text;
ALTER TABLE users ADD COLUMN family_name text;
ALTER TABLE teams ADD COLUMN scim_external_id text;
