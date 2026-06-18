-- Grant Checklane Hub access for Chris Metzger, Monique Barron Perez, and Lily Thiphakhinkeo.

INSERT INTO allowed_emails (email, note) VALUES
  ('monique.perez73@yahoo.com', 'Checklane Hub rep (FM 652, Chris Metzger team)')
ON CONFLICT (email) DO UPDATE SET
  note = EXCLUDED.note,
  updated_at = now();

INSERT INTO hub_users (email, name, sas_user_id, standing_rank, is_active, hub_invited_at) VALUES
  ('chris.metzger@retailodyssey.com', 'Chris Metzger S', 15071, 2, TRUE, now()),
  ('monique.perez73@yahoo.com', 'Monique Barron Perez Theressa', 404705, 1, TRUE, now()),
  ('lily.thiphakhinkeo@sasretailservices.com', 'Vikanda Thiphakhinkeo Lily', 226147, 2, TRUE, now())
ON CONFLICT (email) DO UPDATE SET
  name = COALESCE(NULLIF(EXCLUDED.name, ''), hub_users.name),
  sas_user_id = COALESCE(EXCLUDED.sas_user_id, hub_users.sas_user_id),
  standing_rank = GREATEST(COALESCE(hub_users.standing_rank, 1), EXCLUDED.standing_rank),
  is_active = TRUE,
  hub_invited_at = COALESCE(hub_users.hub_invited_at, now());

INSERT INTO hub_stores (store_number, name) VALUES
  ('652', 'Store 00652'),
  ('214', 'Store 00214'),
  ('657', 'Store 00657')
ON CONFLICT (store_number) DO NOTHING;

DO $$
DECLARE
  chris_id INTEGER;
  monique_id INTEGER;
  lily_id INTEGER;
BEGIN
  SELECT id INTO chris_id FROM hub_users WHERE lower(email) = 'chris.metzger@retailodyssey.com';
  SELECT id INTO monique_id FROM hub_users WHERE lower(email) = 'monique.perez73@yahoo.com';
  SELECT id INTO lily_id FROM hub_users WHERE lower(email) = 'lily.thiphakhinkeo@sasretailservices.com';

  IF chris_id IS NOT NULL THEN
    INSERT INTO hub_store_assignments (store_number, user_id, store_role)
    VALUES ('652', chris_id, 'lead')
    ON CONFLICT (store_number, user_id) DO UPDATE SET store_role = 'lead';
  END IF;

  IF monique_id IS NOT NULL THEN
    INSERT INTO hub_store_assignments (store_number, user_id, store_role)
    VALUES ('652', monique_id, 'rep')
    ON CONFLICT (store_number, user_id) DO UPDATE SET store_role = 'rep';
  END IF;

  IF lily_id IS NOT NULL THEN
    INSERT INTO hub_store_assignments (store_number, user_id, store_role)
    VALUES ('214', lily_id, 'lead')
    ON CONFLICT (store_number, user_id) DO UPDATE SET store_role = 'lead';

    INSERT INTO hub_store_assignments (store_number, user_id, store_role)
    VALUES ('657', lily_id, 'lead')
    ON CONFLICT (store_number, user_id) DO UPDATE SET store_role = 'lead';
  END IF;
END $$;
