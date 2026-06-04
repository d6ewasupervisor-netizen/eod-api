CREATE TABLE IF NOT EXISTS tracker_settings (
  id BIGSERIAL PRIMARY KEY,
  setting_key TEXT NOT NULL UNIQUE,
  setting_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by_email TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
