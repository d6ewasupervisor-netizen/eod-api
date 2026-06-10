ALTER TABLE tracker_snapshot_meta
  ADD COLUMN IF NOT EXISTS si_source TEXT;

ALTER TABLE tracker_snapshot_meta
  ADD COLUMN IF NOT EXISTS si_fallback_reason TEXT;
