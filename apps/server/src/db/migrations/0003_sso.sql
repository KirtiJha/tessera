-- Single sign-on (OIDC), one provider per organisation.

CREATE TABLE org_sso (
  org_id             uuid PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  enabled            boolean NOT NULL DEFAULT false,
  issuer             text NOT NULL,
  client_id          text NOT NULL,
  client_secret_enc  text NOT NULL,
  -- Create a user on first sign-in when their email domain is one of the org's domains.
  jit_provisioning   boolean NOT NULL DEFAULT true,
  default_role       user_role NOT NULL DEFAULT 'operator',
  -- When on, members sign in through SSO only; owners keep their password as a way back in.
  enforce            boolean NOT NULL DEFAULT false,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid REFERENCES users(id) ON DELETE SET NULL
);

-- Which organisation a work email signs in to. A domain belongs to one organisation.
CREATE TABLE sso_domains (
  domain   text PRIMARY KEY,
  org_id   uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  added_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sso_domains_org ON sso_domains (org_id);

-- The identity provider's stable subject for a user, bound on first SSO sign-in.
ALTER TABLE users ADD COLUMN sso_issuer text;
ALTER TABLE users ADD COLUMN sso_subject text;
CREATE UNIQUE INDEX users_sso_identity ON users (sso_issuer, sso_subject) WHERE sso_subject IS NOT NULL;
