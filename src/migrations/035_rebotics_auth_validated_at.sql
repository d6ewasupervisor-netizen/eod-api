CREATE TABLE IF NOT EXISTS rebotics_auth (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  token TEXT NOT NULL,
  user_id INTEGER,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_stale BOOLEAN NOT NULL DEFAULT false
);

ALTER TABLE rebotics_auth
  ADD COLUMN IF NOT EXISTS last_validated_at TIMESTAMPTZ;
