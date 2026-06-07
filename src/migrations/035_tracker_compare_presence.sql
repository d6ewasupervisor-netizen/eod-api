ALTER TABLE tracker_run_items
  ADD COLUMN IF NOT EXISTS expectation TEXT,
  ADD COLUMN IF NOT EXISTS prod_presence_state TEXT,
  ADD COLUMN IF NOT EXISTS si_presence_state TEXT,
  ADD COLUMN IF NOT EXISTS row_state TEXT,
  ADD COLUMN IF NOT EXISTS reason TEXT;

CREATE INDEX IF NOT EXISTS tracker_run_items_row_state_idx
  ON tracker_run_items (run_id, row_state);
