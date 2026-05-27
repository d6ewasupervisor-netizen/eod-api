-- Checklane Hub — store registry, per-store assignments, hub admin flag.

ALTER TABLE hub_users ADD COLUMN IF NOT EXISTS is_hub_admin BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS hub_stores (
  store_number TEXT PRIMARY KEY,
  name TEXT,
  default_visit_id BIGINT,
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hub_store_assignments (
  id SERIAL PRIMARY KEY,
  store_number TEXT NOT NULL REFERENCES hub_stores(store_number) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES hub_users(id) ON DELETE CASCADE,
  store_role TEXT NOT NULL CHECK (store_role IN ('lead', 'rep')),
  assigned_by INTEGER REFERENCES hub_users(id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_number, user_id)
);

CREATE INDEX IF NOT EXISTS idx_hub_store_assignments_user ON hub_store_assignments (user_id);
CREATE INDEX IF NOT EXISTS idx_hub_store_assignments_store ON hub_store_assignments (store_number);

-- Test store 163 (visit 99999163).
INSERT INTO hub_stores (store_number, name, default_visit_id, is_test)
VALUES ('163', 'Store 00163 (Test)', 99999163, TRUE)
ON CONFLICT (store_number) DO UPDATE
  SET name = EXCLUDED.name,
      default_visit_id = EXCLUDED.default_visit_id,
      is_test = EXCLUDED.is_test;

-- Seed hub roster users used for the test store.
INSERT INTO hub_users (email, name, standing_rank) VALUES
  ('d6ewa.supervisor@gmail.com', 'Supervisor Lead', 2),
  ('hub.rep.a@test.local', 'Rep Alex', 1),
  ('hub.rep.b@test.local', 'Rep Bailey', 1),
  ('hub.lead@test.local', 'Lead Casey', 1),
  ('retail.odyssey.supervisor@gmail.com', 'Retail Odyssey Supervisor', 1),
  ('tyson.gauthier@retailodyssey.com', 'Tyson Gauthier', 1)
ON CONFLICT (email) DO NOTHING;

-- Hub admins see all stores; assigned stores still highlighted in UI.
UPDATE hub_users SET is_hub_admin = TRUE
WHERE lower(email) IN (
  'tyson.gauthier@retailodyssey.com',
  'd6ewa.supervisor@gmail.com'
);

-- Store 163 assignments: d6ewa = lead, everyone else active = rep.
DO $$
DECLARE
  lead_id INTEGER;
  u RECORD;
BEGIN
  SELECT id INTO lead_id FROM hub_users WHERE lower(email) = 'd6ewa.supervisor@gmail.com';
  IF lead_id IS NULL THEN RETURN; END IF;

  INSERT INTO hub_store_assignments (store_number, user_id, store_role)
  VALUES ('163', lead_id, 'lead')
  ON CONFLICT (store_number, user_id) DO UPDATE SET store_role = 'lead';

  FOR u IN
    SELECT id FROM hub_users
    WHERE is_active = TRUE
      AND lower(email) <> 'd6ewa.supervisor@gmail.com'
  LOOP
    INSERT INTO hub_store_assignments (store_number, user_id, store_role)
    VALUES ('163', u.id, 'rep')
    ON CONFLICT (store_number, user_id) DO UPDATE SET store_role = 'rep';
  END LOOP;
END $$;
