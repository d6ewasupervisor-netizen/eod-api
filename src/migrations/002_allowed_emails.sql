-- Per-email allowlist for /api/request-link. Corporate work-domain emails are
-- always allowed by application logic (see lib/allowed-emails.js) -- those
-- domains do not need rows here, but we seed the current EOD allowlist
-- verbatim for transparency in admin.html so an admin can audit / remove
-- individuals later without first knowing the domain rule.
CREATE TABLE IF NOT EXISTS allowed_emails (
  email TEXT PRIMARY KEY,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_allowed_emails_updated_at ON allowed_emails(updated_at DESC);

-- Seed: the entire current EOD_APP_ALLOWED_EMAILS env list. Corporate addresses
-- are redundant (the domain rule covers them) but kept so admin.html shows the
-- complete picture. Remove an individual via the admin UI to revoke access.
INSERT INTO allowed_emails (email, note) VALUES
  ('aiyana.natarisalazar@retailodyssey.com', 'Seeded from EOD_APP_ALLOWED_EMAILS'),
  ('alex.wright2@retailodyssey.com',         'Seeded from EOD_APP_ALLOWED_EMAILS'),
  ('james.duchene@retailodyssey.com',        'Seeded from EOD_APP_ALLOWED_EMAILS'),
  ('jes.zumwalt@sasretailservices.com',      'Seeded from EOD_APP_ALLOWED_EMAILS'),
  ('ruth.northcutt@sasretailservices.com',   'Seeded from EOD_APP_ALLOWED_EMAILS'),
  ('d6ewa.supervisor@gmail.com',             'Seeded from EOD_APP_ALLOWED_EMAILS')
ON CONFLICT (email) DO NOTHING;
