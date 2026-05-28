-- Per-bay completion photos submitted when a rep marks a set done.

CREATE TABLE IF NOT EXISTS section_bay_photos (
  id SERIAL PRIMARY KEY,
  visit_id BIGINT NOT NULL,
  lane TEXT NOT NULL DEFAULT '',
  dbkey TEXT NOT NULL,
  bay_num SMALLINT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'image/jpeg',
  photo_base64 TEXT NOT NULL,
  uploaded_by INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (visit_id, lane, dbkey, bay_num)
);

CREATE INDEX IF NOT EXISTS idx_section_bay_photos_visit_section
  ON section_bay_photos (visit_id, lane, dbkey);
