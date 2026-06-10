ALTER TABLE tracker_snapshot_meta
  ADD COLUMN IF NOT EXISTS ingest_status TEXT;

ALTER TABLE tracker_snapshot_meta
  ADD COLUMN IF NOT EXISTS ingest_started_at TIMESTAMPTZ;

ALTER TABLE tracker_snapshot_meta
  ADD COLUMN IF NOT EXISTS ingest_completed_at TIMESTAMPTZ;
