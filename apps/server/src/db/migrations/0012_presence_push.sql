-- How long a person's prompts wait for Tessera before the terminal asks, and what they want to be told about.
ALTER TABLE users ADD COLUMN IF NOT EXISTS presence text NOT NULL DEFAULT 'auto' CHECK (presence IN ('auto', 'desk', 'away'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS notify jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Web Push subscriptions: one per browser or installed app, per person.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    text NOT NULL UNIQUE,
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  label       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_ok_at  timestamptz,
  failures    int NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions (user_id);

-- Keys the server makes for itself once (the Web Push VAPID pair), shared by every replica.
CREATE TABLE IF NOT EXISTS server_keys (
  name        text PRIMARY KEY,
  value       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- One personal push per event across replicas: the first replica to record the key sends it.
CREATE TABLE IF NOT EXISTS push_log (
  key   text PRIMARY KEY,
  at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_log_at ON push_log (at);
