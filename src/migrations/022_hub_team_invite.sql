-- Checklane Hub — per-user invite gate + optional login email override (app-only).

ALTER TABLE hub_users ADD COLUMN IF NOT EXISTS login_email TEXT;
ALTER TABLE hub_users ADD COLUMN IF NOT EXISTS hub_invited_at TIMESTAMPTZ;
ALTER TABLE hub_users ADD COLUMN IF NOT EXISTS last_invite_sent_at TIMESTAMPTZ;
ALTER TABLE hub_users ADD COLUMN IF NOT EXISTS invited_by INTEGER REFERENCES hub_users(id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_hub_users_login_email
  ON hub_users (lower(login_email))
  WHERE login_email IS NOT NULL AND login_email <> '';

-- Existing active users who already use the hub stay invited (no modal on first assign).
UPDATE hub_users
SET hub_invited_at = COALESCE(hub_invited_at, now())
WHERE is_active = true
  AND (
    is_hub_admin = true
    OR standing_rank >= 2
    OR hub_invited_at IS NOT NULL
  );
