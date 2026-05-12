-- Admins who may sign in to /EOD/admin.html and manage the allowed_emails list.
-- First-time setup: when password_hash IS NULL for PRIMARY_ADMIN_EMAIL, posting
-- the ADMIN_SETUP_TOKEN (env var) to /api/admin/session/setup unlocks the slot
-- so the primary admin can choose their password.
CREATE TABLE IF NOT EXISTS site_admins (
  email TEXT PRIMARY KEY,
  password_hash TEXT,
  password_set_at TIMESTAMPTZ
);

-- Seed the primary admin row. PRIMARY_ADMIN_EMAIL env var overrides this at
-- runtime for the bootstrap check; the row itself just needs to exist so the
-- /status endpoint can report `needsPasswordSetup`.
INSERT INTO site_admins (email, password_hash)
VALUES ('tyson.gauthier@retailodyssey.com', NULL)
ON CONFLICT (email) DO NOTHING;
