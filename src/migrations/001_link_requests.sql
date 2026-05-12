-- Single-use, email-delivered "magic link" tokens. Issued by /api/request-link
-- and consumed by /api/verify-token, which marks `used_at` and returns a
-- long-lived session JWT that the browser stores in localStorage.
CREATE TABLE IF NOT EXISTS link_requests (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  jti TEXT NOT NULL UNIQUE,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  used_at TIMESTAMPTZ,
  ip TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_link_requests_email ON link_requests(email);
CREATE INDEX IF NOT EXISTS idx_link_requests_jti ON link_requests(jti);
