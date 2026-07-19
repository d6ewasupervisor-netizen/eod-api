-- Optional photo attachments for survey responses. Stored in Postgres;
-- migrate to object storage later if volume warrants.
CREATE TABLE IF NOT EXISTS survey_photos (
  id          SERIAL PRIMARY KEY,
  store_num   INTEGER NOT NULL,
  respondent  TEXT NOT NULL REFERENCES survey_roster(email),
  question_id TEXT NOT NULL,
  mime        TEXT NOT NULL,
  bytes       BYTEA NOT NULL,
  caption     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_survey_photos_store ON survey_photos(store_num);
CREATE INDEX IF NOT EXISTS idx_survey_photos_resp ON survey_photos(respondent);
