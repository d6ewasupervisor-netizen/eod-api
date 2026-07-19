-- Historical snapshots of survey answers. survey_responses remains the current
-- "live" row used for metrics; each save/submit that changes data archives prior.

CREATE TABLE IF NOT EXISTS survey_response_history (
  id              SERIAL PRIMARY KEY,
  response_id     INTEGER REFERENCES survey_responses(id) ON DELETE SET NULL,
  question_set_id INTEGER NOT NULL REFERENCES survey_question_sets(id),
  store_num       INTEGER NOT NULL,
  respondent      TEXT NOT NULL,
  answers         JSONB NOT NULL DEFAULT '{}'::jsonb,
  photos          JSONB NOT NULL DEFAULT '[]'::jsonb,
  status          TEXT NOT NULL,
  snapshot_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  source          TEXT NOT NULL DEFAULT 'save'
);

CREATE INDEX IF NOT EXISTS idx_survey_resp_hist_store
  ON survey_response_history (store_num, snapshot_at DESC);
CREATE INDEX IF NOT EXISTS idx_survey_resp_hist_resp
  ON survey_response_history (respondent, store_num, snapshot_at DESC);
CREATE INDEX IF NOT EXISTS idx_survey_resp_hist_response
  ON survey_response_history (response_id, snapshot_at DESC);
