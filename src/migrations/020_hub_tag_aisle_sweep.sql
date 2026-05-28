-- Checklane Hub — aisle-by-aisle missing-tag sweep.
--
-- Reframes the missing-tag flow around store aisles instead of per-set verify:
--   * tag_flags can now be created during a lead/assignee aisle sweep (source='sweep'),
--     which may not be tied to a single planogram (dbkey is now nullable).
--   * aisle_label freezes the store aisle for sweep-added tags so batches group/send by aisle.
--   * tag_sweep_assignments lets a lead/supervisor hand an aisle's sweep to a rep, who can
--     then scan, add, and send/print that aisle's batch themselves.
--
-- tag_flags.status lifecycle (revised — the aisle sweep replaces the verify gate):
--   draft   → rep building a per-section list (unchanged)
--   flagged → pending in the tag batch, grouped by aisle (rep submit OR sweep add)
--   sent    → aisle batch emailed/printed (terminal)
--   rejected/verified → legacy terminal/transitional states still accepted for back-compat

ALTER TABLE tag_flags ALTER COLUMN dbkey DROP NOT NULL;
ALTER TABLE tag_flags ADD COLUMN IF NOT EXISTS lane TEXT NOT NULL DEFAULT '';
ALTER TABLE tag_flags ADD COLUMN IF NOT EXISTS aisle_key TEXT;
ALTER TABLE tag_flags ADD COLUMN IF NOT EXISTS aisle_label TEXT;
ALTER TABLE tag_flags ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'rep';

CREATE INDEX IF NOT EXISTS idx_tag_flags_visit_pending
  ON tag_flags (visit_id, status)
  WHERE status IN ('flagged', 'verified');

CREATE TABLE IF NOT EXISTS tag_sweep_assignments (
  id SERIAL PRIMARY KEY,
  visit_id BIGINT NOT NULL,
  aisle_key TEXT NOT NULL,
  aisle_label TEXT NOT NULL,
  assignee_id INTEGER NOT NULL REFERENCES hub_users(id),
  assigned_by INTEGER NOT NULL REFERENCES hub_users(id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (visit_id, aisle_key)
);

CREATE INDEX IF NOT EXISTS idx_tag_sweep_assignments_visit
  ON tag_sweep_assignments (visit_id);
CREATE INDEX IF NOT EXISTS idx_tag_sweep_assignments_assignee
  ON tag_sweep_assignments (visit_id, assignee_id);
