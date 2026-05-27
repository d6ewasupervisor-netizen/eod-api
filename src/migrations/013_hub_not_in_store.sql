-- Terminal not_in_store state for lead-verified NIS flags (distinct from signed_off).

UPDATE section_state ss
SET state = 'not_in_store', updated_at = now()
FROM pending_actions pa
WHERE pa.visit_id = ss.visit_id
  AND pa.dbkey = ss.dbkey
  AND COALESCE(pa.lane, '') = COALESCE(ss.lane, '')
  AND pa.action_type = 'nis'
  AND pa.status = 'verified'
  AND ss.state <> 'not_in_store';
