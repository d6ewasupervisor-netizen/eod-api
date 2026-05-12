-- Self-serve access requests from /EOD/signin.html overlay. An UPDATE … WHERE
-- status='pending' RETURNING * gives first-click-wins between the two emailed
-- decision links without an explicit lock.
CREATE TABLE IF NOT EXISTS access_requests (
  id             TEXT        PRIMARY KEY,
  name           TEXT        NOT NULL,
  email          TEXT        NOT NULL,
  reason         TEXT,
  status         TEXT        NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'denied'
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at     TIMESTAMPTZ,
  decided_by     TEXT,
  decided_action TEXT
);

CREATE INDEX IF NOT EXISTS idx_access_requests_email  ON access_requests (lower(email));
CREATE INDEX IF NOT EXISTS idx_access_requests_status ON access_requests (status);
