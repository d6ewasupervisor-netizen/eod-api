-- Per-visit hub backup sequence counter (monotonic; gaps indicate missed sends).

CREATE TABLE IF NOT EXISTS hub_backup_seq (
  visit_id BIGINT PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0
);
