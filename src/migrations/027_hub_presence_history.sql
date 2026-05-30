-- Checklane Hub — persisted presence/activity history (owner-visible).

CREATE TABLE IF NOT EXISTS hub_presence_history (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  hub_user_id INTEGER,
  email TEXT NOT NULL,
  name TEXT,
  page TEXT,
  store_number TEXT,
  visit_id BIGINT,
  view TEXT,
  detail TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hub_presence_history_started
  ON hub_presence_history (started_at DESC);

CREATE INDEX IF NOT EXISTS idx_hub_presence_history_email_started
  ON hub_presence_history (email, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_hub_presence_history_store_started
  ON hub_presence_history (store_number, started_at DESC)
  WHERE store_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_hub_presence_history_open_session
  ON hub_presence_history (session_id)
  WHERE ended_at IS NULL;
