CREATE TABLE IF NOT EXISTS tracker_runs (
  id BIGSERIAL PRIMARY KEY,
  run_key UUID NOT NULL UNIQUE,
  created_by_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  params_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  progress_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  warnings_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  error_text TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tracker_runs_created_at_idx
  ON tracker_runs (created_at DESC);

CREATE TABLE IF NOT EXISTS tracker_run_items (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES tracker_runs(id) ON DELETE CASCADE,
  store_number TEXT,
  work_date DATE,
  period_week TEXT,
  project_id INTEGER,
  project_name TEXT,
  dbkey TEXT,
  pog TEXT,
  category_set_label TEXT,
  prod_status TEXT,
  si_status TEXT,
  prod_photo_count INTEGER NOT NULL DEFAULT 0,
  si_photo_count INTEGER NOT NULL DEFAULT 0,
  confidence TEXT NOT NULL DEFAULT 'needs_review',
  notes TEXT,
  source_refs_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tracker_run_items_run_id_idx
  ON tracker_run_items (run_id);

CREATE INDEX IF NOT EXISTS tracker_run_items_lookup_idx
  ON tracker_run_items (run_id, store_number, dbkey, pog);

CREATE TABLE IF NOT EXISTS tracker_run_images (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES tracker_runs(id) ON DELETE CASCADE,
  item_id BIGINT REFERENCES tracker_run_items(id) ON DELETE CASCADE,
  source_system TEXT NOT NULL,
  image_role TEXT NOT NULL DEFAULT 'after',
  source_ref TEXT,
  source_url TEXT,
  action_id BIGINT,
  bay_index INTEGER,
  captured_at TIMESTAMPTZ,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tracker_run_images_run_id_idx
  ON tracker_run_images (run_id);

CREATE INDEX IF NOT EXISTS tracker_run_images_item_id_idx
  ON tracker_run_images (item_id);
