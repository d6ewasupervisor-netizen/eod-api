-- Photos attached to a pending action (help / not-in-store flags) at flag time.

CREATE TABLE IF NOT EXISTS pending_action_photos (
  id SERIAL PRIMARY KEY,
  visit_id BIGINT NOT NULL,
  pending_id INTEGER NOT NULL REFERENCES pending_actions(id) ON DELETE CASCADE,
  idx SMALLINT NOT NULL DEFAULT 0,
  content_type TEXT NOT NULL DEFAULT 'image/jpeg',
  photo_base64 TEXT NOT NULL,
  uploaded_by INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pending_action_photos_pending
  ON pending_action_photos (visit_id, pending_id, idx);
