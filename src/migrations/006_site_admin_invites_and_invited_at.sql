-- Invite flow for secondary site admins (JWT+jti mirrored from link_requests).
-- Optional invited_at records when someone was last invited to complete setup.

ALTER TABLE site_admins ADD COLUMN IF NOT EXISTS invited_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS site_admin_invites (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  jti TEXT NOT NULL UNIQUE,
  invited_by TEXT,
  note TEXT,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_site_admin_invites_email ON site_admin_invites(email);
CREATE INDEX IF NOT EXISTS idx_site_admin_invites_jti ON site_admin_invites(jti);
