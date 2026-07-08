-- DC Scan volunteer board: supervisor-approved extra volunteers and access requests.

CREATE TABLE IF NOT EXISTS dc_scan_volunteer_grants (
  email       TEXT        PRIMARY KEY,
  name        TEXT,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  granted_by  TEXT
);

CREATE TABLE IF NOT EXISTS dc_scan_access_requests (
  id             TEXT        PRIMARY KEY,
  name           TEXT        NOT NULL,
  email          TEXT        NOT NULL,
  reason         TEXT,
  status         TEXT        NOT NULL DEFAULT 'pending',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at     TIMESTAMPTZ,
  decided_by     TEXT,
  decided_action TEXT
);

CREATE INDEX IF NOT EXISTS idx_dc_scan_access_requests_email
  ON dc_scan_access_requests (lower(email));
CREATE INDEX IF NOT EXISTS idx_dc_scan_access_requests_status
  ON dc_scan_access_requests (status);
