-- Per-planogram store aisle designation (preset or custom label).

ALTER TABLE section_state ADD COLUMN IF NOT EXISTS aisle_preset TEXT;
ALTER TABLE section_state ADD COLUMN IF NOT EXISTS aisle_custom TEXT;

CREATE INDEX IF NOT EXISTS idx_section_state_visit_aisle_preset
  ON section_state (visit_id, aisle_preset)
  WHERE aisle_preset IS NOT NULL;
