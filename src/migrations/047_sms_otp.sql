-- One-time SMS PIN codes for Dump Bin sign-in (Twilio).
-- Plaintext PIN is never stored; only a SHA-256 hash of pin+email+pepper.

CREATE TABLE IF NOT EXISTS sms_otp_challenges (
  id          SERIAL PRIMARY KEY,
  email       TEXT NOT NULL,
  phone_e164  TEXT NOT NULL,
  pin_hash    TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  issued_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  ip          TEXT,
  user_agent  TEXT
);

CREATE INDEX IF NOT EXISTS idx_sms_otp_email_active
  ON sms_otp_challenges (lower(email), expires_at DESC)
  WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sms_otp_issued_at ON sms_otp_challenges (issued_at DESC);
