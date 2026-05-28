-- Physical lane names for Checklane Reset Hub (maps register 601–624 to store floor labels).

CREATE TABLE IF NOT EXISTS lane_physical_names (
  id SERIAL PRIMARY KEY,
  visit_id BIGINT NOT NULL,
  lane TEXT NOT NULL,
  physical_name TEXT NOT NULL,
  updated_by INTEGER REFERENCES hub_users (id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (visit_id, lane)
);

CREATE INDEX IF NOT EXISTS idx_lane_physical_names_visit_id ON lane_physical_names (visit_id);
