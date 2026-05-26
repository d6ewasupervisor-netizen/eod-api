-- Decision payload retained until local flow acks or grace TTL elapses.

ALTER TABLE review_sessions
  ADD COLUMN IF NOT EXISTS decision_grace_expires_at TIMESTAMPTZ;

ALTER TABLE review_sessions
  ADD COLUMN IF NOT EXISTS payload_acked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_review_sessions_decision_grace
  ON review_sessions (decision_grace_expires_at)
  WHERE decision_payload IS NOT NULL;
