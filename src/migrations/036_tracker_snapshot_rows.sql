CREATE TABLE IF NOT EXISTS tracker_snapshot_rows (
  id BIGSERIAL PRIMARY KEY,
  workbook_kind TEXT NOT NULL,
  store TEXT NOT NULL,
  period_week TEXT NOT NULL,
  category_id INTEGER NOT NULL,
  dbkey TEXT NOT NULL,
  row_index INTEGER NOT NULL,
  set_type TEXT,
  current_k TEXT,
  current_l TEXT,
  bucket TEXT,
  bucket_reason TEXT,
  expectation TEXT,
  refreshed_at TIMESTAMPTZ NOT NULL,
  UNIQUE (workbook_kind, store, period_week, category_id, dbkey)
);

CREATE INDEX IF NOT EXISTS tracker_snapshot_rows_workbook_kind_idx
  ON tracker_snapshot_rows (workbook_kind);

CREATE INDEX IF NOT EXISTS tracker_snapshot_rows_store_period_week_idx
  ON tracker_snapshot_rows (store, period_week);

CREATE TABLE IF NOT EXISTS tracker_snapshot_meta (
  workbook_kind TEXT PRIMARY KEY,
  refreshed_at TIMESTAMPTZ NOT NULL,
  row_count INTEGER NOT NULL,
  last_error TEXT
);
