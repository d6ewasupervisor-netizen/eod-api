-- Transient review sessions for mobile approve/adjust flows.
-- Draft content is purged on decision; only metadata survives long-term.

CREATE TABLE IF NOT EXISTS review_sessions (
  id                  TEXT        PRIMARY KEY,
  surface_id          TEXT        NOT NULL,
  period_week         TEXT,
  approver_email      TEXT        NOT NULL,
  status              TEXT        NOT NULL DEFAULT 'pending',
  draft_json          JSONB,
  findings_json       JSONB,
  promotion_offers_json JSONB,
  decision_payload    JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at          TIMESTAMPTZ,
  expires_at          TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_review_sessions_status ON review_sessions (status);
CREATE INDEX IF NOT EXISTS idx_review_sessions_expires ON review_sessions (expires_at);
