ALTER TABLE tracker_snapshot_meta
  ADD COLUMN IF NOT EXISTS ingest_heartbeat_at TIMESTAMPTZ;

ALTER TABLE tracker_snapshot_meta
  ADD COLUMN IF NOT EXISTS ingest_stage TEXT;
