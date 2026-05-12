-- Opaque one-time tokens emailed for admin forgot-password flows. The plaintext
-- token only lives in the email and the reset URL; the DB stores SHA-256 of it.
CREATE TABLE IF NOT EXISTS admin_password_resets (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_pw_reset_unused_token_hash
  ON admin_password_resets (token_hash)
  WHERE used_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_admin_pw_reset_email ON admin_password_resets (lower(trim(email)));
