-- Survey admin: districts + per-admin saved views
-- Renumber if 045 is taken.

ALTER TABLE survey_roster ADD COLUMN IF NOT EXISTS district TEXT;

CREATE TABLE IF NOT EXISTS survey_store_districts (
  store_num INTEGER PRIMARY KEY,
  district  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS survey_admin_views (
  id         SERIAL PRIMARY KEY,
  email      TEXT NOT NULL,
  name       TEXT NOT NULL,
  config     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (email, name)
);
