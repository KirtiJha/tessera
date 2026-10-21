-- Every repository a session has worked in, when it moved between several.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS worked_in jsonb NOT NULL DEFAULT '[]'::jsonb;
