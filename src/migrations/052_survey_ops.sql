-- Survey ops: store coverage assignments, reminders, alert preferences

CREATE TABLE IF NOT EXISTS survey_assignments (
  id              SERIAL PRIMARY KEY,
  store_num       INTEGER NOT NULL,
  assignee_email  TEXT NOT NULL REFERENCES survey_roster(email),
  assigned_by     TEXT NOT NULL REFERENCES survey_roster(email),
  due_at          DATE,
  status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'done', 'cancelled')),
  notes           TEXT,
  scope_label     TEXT,
  invite_sent_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_survey_assignments_store
  ON survey_assignments (store_num);
CREATE INDEX IF NOT EXISTS idx_survey_assignments_assignee
  ON survey_assignments (assignee_email);
CREATE INDEX IF NOT EXISTS idx_survey_assignments_status
  ON survey_assignments (status);

CREATE UNIQUE INDEX IF NOT EXISTS survey_assignments_one_open
  ON survey_assignments (store_num, assignee_email)
  WHERE status = 'open';

CREATE TABLE IF NOT EXISTS survey_assignment_reminders (
  id              SERIAL PRIMARY KEY,
  assignment_id   INTEGER NOT NULL REFERENCES survey_assignments(id) ON DELETE CASCADE,
  remind_at       TIMESTAMPTZ NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'due'
                    CHECK (kind IN ('due', 'custom', 'digest')),
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_survey_assign_reminders_due
  ON survey_assignment_reminders (remind_at)
  WHERE sent_at IS NULL;

CREATE TABLE IF NOT EXISTS survey_alert_prefs (
  email                 TEXT PRIMARY KEY REFERENCES survey_roster(email),
  notify_on_submit      BOOLEAN NOT NULL DEFAULT TRUE,
  notify_on_due_soon    BOOLEAN NOT NULL DEFAULT TRUE,
  notify_weekly_digest  BOOLEAN NOT NULL DEFAULT FALSE,
  districts             TEXT[] NOT NULL DEFAULT '{}',
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
