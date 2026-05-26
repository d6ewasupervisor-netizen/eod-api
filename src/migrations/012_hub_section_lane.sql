-- Per-lane section state: same planogram (dbkey) can have different assignees per register lane.

ALTER TABLE section_state ADD COLUMN IF NOT EXISTS lane TEXT NOT NULL DEFAULT '';

ALTER TABLE section_state DROP CONSTRAINT IF EXISTS section_state_visit_id_dbkey_key;

ALTER TABLE section_state
  ADD CONSTRAINT section_state_visit_id_lane_dbkey_key UNIQUE (visit_id, lane, dbkey);

CREATE INDEX IF NOT EXISTS idx_section_state_visit_lane_dbkey
  ON section_state (visit_id, lane, dbkey);

ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS lane TEXT NOT NULL DEFAULT '';
