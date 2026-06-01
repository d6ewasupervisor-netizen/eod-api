-- Remove hub test store 163 seed data; keep FM 163 as a normal fixture store.
-- Stale non-blitz schedules for fixture stores are trimmed to the current blitz week.

DELETE FROM hub_store_assignments WHERE store_number = '163';

UPDATE hub_stores
SET name = 'FM 163',
    is_test = FALSE,
    default_visit_id = NULL,
    live_visit_id = NULL,
    live_visit_pinned_at = NULL,
    live_visit_pinned_by = NULL
WHERE store_number = '163';

DELETE FROM section_state WHERE visit_id = 99999163;

DELETE FROM schedules
WHERE visit_id = 99999163
   OR (store_number = 163 AND project_id IS DISTINCT FROM 1715);

UPDATE hub_users
SET is_active = FALSE
WHERE lower(email) LIKE '%@test.local'
   OR lower(email) IN (
     'hub.rep.a@test.local',
     'hub.rep.b@test.local',
     'hub.lead@test.local'
   );
