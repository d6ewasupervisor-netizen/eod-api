-- Pending PROD photo upload approvals after Checklanes hub sign-off.

CREATE TABLE IF NOT EXISTS hub_prod_dispatch_requests (
  id SERIAL PRIMARY KEY,
  visit_id BIGINT NOT NULL,
  lane TEXT NOT NULL DEFAULT '',
  dbkey TEXT NOT NULL,
  store_number TEXT,
  set_name TEXT,
  manifest_pog_id TEXT,
  action_code TEXT,
  signed_off_by INT REFERENCES hub_users(id),
  signed_off_by_name TEXT,
  signed_off_by_email TEXT,
  signed_off_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approver_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  decision_at TIMESTAMPTZ,
  decision_note TEXT,
  matched_reset_id BIGINT,
  matched_reset_name TEXT,
  matched_reset_planogram_id TEXT,
  upload_result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hub_prod_dispatch_pending
  ON hub_prod_dispatch_requests (approver_email, status)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_hub_prod_dispatch_visit
  ON hub_prod_dispatch_requests (visit_id, dbkey, lane);
