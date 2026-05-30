-- Grant Checklane Hub supervisor standing rank to Amanda Mathews and Seth Newman.

INSERT INTO hub_users (email, name, standing_rank) VALUES
  ('amanda.mathews@retailodyssey.com', 'Amanda Mathews', 3),
  ('seth.newman@retailodyssey.com', 'Seth Newman', 3)
ON CONFLICT (email) DO UPDATE SET
  standing_rank = GREATEST(hub_users.standing_rank, EXCLUDED.standing_rank),
  name = COALESCE(NULLIF(EXCLUDED.name, ''), hub_users.name);
