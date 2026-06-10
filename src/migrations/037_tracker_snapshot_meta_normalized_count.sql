ALTER TABLE tracker_snapshot_meta
  ADD COLUMN IF NOT EXISTS normalized_row_count INTEGER;
