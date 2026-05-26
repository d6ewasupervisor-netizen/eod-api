-- Checklane Hub Step 6: tag batch email lifecycle.
--
-- tag_flags.status lifecycle:
--   flagged  → rep raised missing-tag (awaiting lead verify)
--   verified → lead approved via pending_actions verify gate (ready for tag batch)
--   sent     → lead POST send-tag-batch emailed PDF to price-changer (terminal)
--   rejected → lead rejected the flag (terminal)
--
-- Only status='verified' rows are included in the next tag batch send.

ALTER TABLE tag_flags
  ADD COLUMN IF NOT EXISTS sent_by INTEGER REFERENCES hub_users(id),
  ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_tag_flags_visit_verified
  ON tag_flags (visit_id, status)
  WHERE status = 'verified';
