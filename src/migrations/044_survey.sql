-- Survey module: roster, store access, question sets, responses, baseline
-- Renumber to match next migration slot if 043 is taken.

CREATE TABLE IF NOT EXISTS survey_roster (
  email            TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  phone            TEXT,
  workday_id       TEXT,
  title            TEXT,
  role             TEXT NOT NULL CHECK (role IN ('supervisor','lead','member')),
  team             TEXT,
  supervisor_email TEXT,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS survey_store_access (
  email      TEXT NOT NULL REFERENCES survey_roster(email) ON DELETE CASCADE,
  store_num  INTEGER NOT NULL,
  PRIMARY KEY (email, store_num)
);
CREATE INDEX IF NOT EXISTS idx_survey_store_access_store ON survey_store_access(store_num);

-- Supervisors of record per store ("both" rule: every supervisor with members at the store)
CREATE TABLE IF NOT EXISTS survey_store_supervisors (
  store_num        INTEGER NOT NULL,
  supervisor_email TEXT NOT NULL REFERENCES survey_roster(email) ON DELETE CASCADE,
  PRIMARY KEY (store_num, supervisor_email)
);

-- Versioned question sets; questions stored as JSONB spec
CREATE TABLE IF NOT EXISTS survey_question_sets (
  id         SERIAL PRIMARY KEY,
  version    INTEGER NOT NULL UNIQUE,
  title      TEXT NOT NULL,
  spec       JSONB NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS survey_responses (
  id              SERIAL PRIMARY KEY,
  question_set_id INTEGER NOT NULL REFERENCES survey_question_sets(id),
  store_num       INTEGER NOT NULL,
  respondent      TEXT NOT NULL REFERENCES survey_roster(email),
  answers         JSONB NOT NULL DEFAULT '{}'::jsonb,
  photos          JSONB NOT NULL DEFAULT '[]'::jsonb,
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted')),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at    TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (question_set_id, store_num, respondent)
);
CREATE INDEX IF NOT EXISTS idx_survey_responses_store ON survey_responses(store_num);

-- 2025 Microsoft Forms results, mapped to v2 question ids; read-only historical
CREATE TABLE IF NOT EXISTS survey_baseline (
  id         SERIAL PRIMARY KEY,
  store_num  INTEGER NOT NULL,
  respondent TEXT,
  submitted  TIMESTAMPTZ,
  answers    JSONB NOT NULL DEFAULT '{}'::jsonb,
  source     TEXT NOT NULL DEFAULT 'ms-forms-2025'
);
CREATE INDEX IF NOT EXISTS idx_survey_baseline_store ON survey_baseline(store_num);
