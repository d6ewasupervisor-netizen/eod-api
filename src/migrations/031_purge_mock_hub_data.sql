-- Drop mock Kompass cycle 242292, synthetic 99999* visits, and hub test fixtures.
-- Live blitz data comes from scripts/sync-checklane-visits-from-prod.js (project 1715).

DO $$
DECLARE
  mock_ids BIGINT[];
  tbl TEXT;
BEGIN
  SELECT ARRAY_AGG(DISTINCT visit_id) INTO mock_ids
  FROM (
    SELECT visit_id::bigint AS visit_id
    FROM schedules
    WHERE cycle_id = 242292
       OR visit_id_full LIKE 'mock-%'
       OR (visit_id >= 99999000 AND visit_id <= 99999999)
    UNION SELECT 99999163::bigint
  ) s;

  IF mock_ids IS NOT NULL THEN
    FOREACH tbl IN ARRAY ARRAY[
      'hub_prod_dispatch_requests',
      'tag_sweep_assignments',
      'section_bay_photos',
      'lane_physical_names',
      'pending_action_photos',
      'pending_actions',
      'tag_flags',
      'role_grants',
      'audit_log',
      'email_log',
      'section_state'
    ] LOOP
      EXECUTE format('DELETE FROM %I WHERE visit_id = ANY($1)', tbl) USING mock_ids;
    END LOOP;

    DELETE FROM hub_message_reads
    WHERE thread_id IN (SELECT id FROM hub_message_threads WHERE visit_id = ANY(mock_ids));
    DELETE FROM hub_messages
    WHERE thread_id IN (SELECT id FROM hub_message_threads WHERE visit_id = ANY(mock_ids));
    DELETE FROM hub_message_threads WHERE visit_id = ANY(mock_ids);
  END IF;

  DELETE FROM schedules
  WHERE cycle_id = 242292
     OR visit_id_full LIKE 'mock-%'
     OR (visit_id >= 99999000 AND visit_id <= 99999999);

  UPDATE hub_stores
  SET default_visit_id = NULL,
      live_visit_id = NULL,
      live_visit_pinned_at = NULL,
      live_visit_pinned_by = NULL,
      is_test = FALSE
  WHERE is_test = TRUE
     OR (mock_ids IS NOT NULL AND (
       default_visit_id = ANY(mock_ids) OR live_visit_id = ANY(mock_ids)
     ));

  UPDATE hub_users
  SET is_active = FALSE
  WHERE lower(email) LIKE '%@test.local'
     OR lower(email) IN (
       'hub.rep.a@test.local',
       'hub.rep.b@test.local',
       'hub.lead@test.local'
     );
END $$;
