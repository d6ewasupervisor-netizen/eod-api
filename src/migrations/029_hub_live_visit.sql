-- Canonical live visit per store (pinned when a lead opens the hub or starts work).

ALTER TABLE hub_stores
  ADD COLUMN IF NOT EXISTS live_visit_id BIGINT,
  ADD COLUMN IF NOT EXISTS live_visit_pinned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS live_visit_pinned_by INTEGER REFERENCES hub_users(id);

CREATE INDEX IF NOT EXISTS idx_hub_stores_live_visit ON hub_stores (live_visit_id)
  WHERE live_visit_id IS NOT NULL;
