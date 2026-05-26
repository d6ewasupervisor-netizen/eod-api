-- Checklane Hub: missing-tag draft workflow + gather indexes.

CREATE INDEX IF NOT EXISTS idx_tag_flags_visit_draft
  ON tag_flags (visit_id, dbkey, status)
  WHERE status = 'draft';

CREATE INDEX IF NOT EXISTS idx_tag_flags_visit_flagged
  ON tag_flags (visit_id, status)
  WHERE status = 'flagged';
