-- Grant Checklane Hub supervisor access to Michael Ashabranner and Richard Beck.
-- Richard Beck uses @fredmeyer.com (not a corporate sign-in domain) — allowlist row required.

INSERT INTO allowed_emails (email, note) VALUES
  ('richard.beck@fredmeyer.com', 'Checklane Hub supervisor (Fred Meyer)')
ON CONFLICT (email) DO NOTHING;

INSERT INTO hub_users (email, name, standing_rank) VALUES
  ('mashabranner@retailodyssey.com', 'Michael Ashabranner', 3),
  ('richard.beck@fredmeyer.com', 'Richard Beck', 3)
ON CONFLICT (email) DO UPDATE SET
  standing_rank = GREATEST(hub_users.standing_rank, EXCLUDED.standing_rank),
  name = COALESCE(NULLIF(EXCLUDED.name, ''), hub_users.name);
