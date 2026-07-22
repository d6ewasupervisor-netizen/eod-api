-- EOD PDF + sign-off images stored on Railway volume; metadata in Postgres.
-- Public download/view via JWT links (see lib/eod-artifact-jwt.js).
CREATE TABLE IF NOT EXISTS eod_artifacts (
  id            BIGSERIAL PRIMARY KEY,
  package_id    UUID NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('pdf', 'signoff')),
  filename      TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  rel_path      TEXT NOT NULL UNIQUE,
  store_number  TEXT,
  sort_index    INTEGER NOT NULL DEFAULT 0,
  sent_email_id BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_eod_artifacts_package ON eod_artifacts(package_id);
CREATE INDEX IF NOT EXISTS idx_eod_artifacts_created ON eod_artifacts(created_at);
CREATE INDEX IF NOT EXISTS idx_eod_artifacts_store ON eod_artifacts(store_number);
