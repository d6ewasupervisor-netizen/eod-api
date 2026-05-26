-- Checklane Reset Hub — core tables (visit_id partition + dbkey section).

CREATE TABLE IF NOT EXISTS hub_users (
  id SERIAL PRIMARY KEY,
  sas_user_id INTEGER UNIQUE,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  standing_rank SMALLINT NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS role_grants (
  id SERIAL PRIMARY KEY,
  visit_id BIGINT NOT NULL,
  grantee_id INTEGER NOT NULL,
  granted_rank SMALLINT NOT NULL,
  granted_by INTEGER NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS section_state (
  id SERIAL PRIMARY KEY,
  visit_id BIGINT NOT NULL,
  dbkey TEXT NOT NULL,
  reset_id BIGINT,
  state TEXT NOT NULL DEFAULT 'not_started',
  assignee_id INTEGER,
  assigned_by INTEGER,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  signed_off_by INTEGER,
  signed_off_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (visit_id, dbkey)
);

CREATE TABLE IF NOT EXISTS tag_flags (
  id SERIAL PRIMARY KEY,
  visit_id BIGINT NOT NULL,
  dbkey TEXT NOT NULL,
  upc TEXT NOT NULL,
  description TEXT,
  location TEXT,
  flagged_by INTEGER NOT NULL,
  flagged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_by INTEGER,
  verified_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'flagged'
);

CREATE TABLE IF NOT EXISTS pending_actions (
  id SERIAL PRIMARY KEY,
  visit_id BIGINT NOT NULL,
  dbkey TEXT,
  action_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  raised_by INTEGER NOT NULL,
  raised_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_by INTEGER,
  verified_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS email_log (
  id SERIAL PRIMARY KEY,
  visit_id BIGINT NOT NULL,
  email_type TEXT NOT NULL,
  recipients TEXT[] NOT NULL,
  subject TEXT,
  body_summary TEXT,
  sent_by INTEGER NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resend_id TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  visit_id BIGINT NOT NULL,
  actor_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_section_state_visit_id ON section_state (visit_id);
CREATE INDEX IF NOT EXISTS idx_tag_flags_visit_id ON tag_flags (visit_id);
CREATE INDEX IF NOT EXISTS idx_pending_actions_visit_id_status ON pending_actions (visit_id, status);
CREATE INDEX IF NOT EXISTS idx_audit_log_visit_id ON audit_log (visit_id);

-- Test visit for store 00163 (visit_id 99999163). Idempotent: skip if any rows exist.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM section_state WHERE visit_id = 99999163 LIMIT 1) THEN
    INSERT INTO section_state (visit_id, dbkey, state) VALUES
      (99999163, '8841499', 'not_started'),
      (99999163, '8790015', 'assigned'),
      (99999163, '9088143', 'assigned'),
      (99999163, '8790016', 'in_progress'),
      (99999163, '9044474', 'in_progress'),
      (99999163, '8844804', 'needs_attention'),
      (99999163, '9088146', 'needs_attention'),
      (99999163, '8920139', 'done_pending_signoff'),
      (99999163, '9009220', 'done_pending_signoff'),
      (99999163, '9086453', 'signed_off'),
      (99999163, '8885976', 'signed_off'),
      (99999163, '9009221', 'signed_off');
  END IF;
END $$;
