-- Grant Checklane Hub access for Dennis Baker and Chance Ward (FM 652 blitz team).

INSERT INTO allowed_emails (email, note) VALUES
  ('chancefsss@gmail.com', 'Checklane Hub rep (FM 652 blitz, Chris Metzger team)')
ON CONFLICT (email) DO UPDATE SET
  note = EXCLUDED.note,
  updated_at = now();

INSERT INTO hub_users (email, name, sas_user_id, standing_rank, is_active, hub_invited_at) VALUES
  ('dennis.baker@sasretailservices.com', 'Dennis Baker III Lloyd', 378774, 1, TRUE, now()),
  ('chancefsss@gmail.com', 'Chance Ward Jaxon', 407929, 1, TRUE, now())
ON CONFLICT (email) DO UPDATE SET
  name = COALESCE(NULLIF(EXCLUDED.name, ''), hub_users.name),
  sas_user_id = COALESCE(EXCLUDED.sas_user_id, hub_users.sas_user_id),
  standing_rank = GREATEST(COALESCE(hub_users.standing_rank, 1), EXCLUDED.standing_rank),
  is_active = TRUE,
  hub_invited_at = COALESCE(hub_users.hub_invited_at, now());

INSERT INTO hub_stores (store_number, name) VALUES
  ('652', 'Store 00652')
ON CONFLICT (store_number) DO NOTHING;

DO $$
DECLARE
  dennis_id INTEGER;
  chance_id INTEGER;
BEGIN
  SELECT id INTO dennis_id FROM hub_users WHERE lower(email) = 'dennis.baker@sasretailservices.com';
  SELECT id INTO chance_id FROM hub_users WHERE lower(email) = 'chancefsss@gmail.com';

  IF dennis_id IS NOT NULL THEN
    INSERT INTO hub_store_assignments (store_number, user_id, store_role)
    VALUES ('652', dennis_id, 'rep')
    ON CONFLICT (store_number, user_id) DO UPDATE SET store_role = 'rep';
  END IF;

  IF chance_id IS NOT NULL THEN
    INSERT INTO hub_store_assignments (store_number, user_id, store_role)
    VALUES ('652', chance_id, 'rep')
    ON CONFLICT (store_number, user_id) DO UPDATE SET store_role = 'rep';
  END IF;
END $$;
