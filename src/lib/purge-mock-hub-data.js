// Remove mock Kompass cycle 242292, synthetic 99999* visits, and hub test fixtures.

const MOCK_CYCLE_ID = 242292;

const HUB_VISIT_TABLES = [
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
  'section_state',
];

async function collectMockVisitIds(client) {
  const { rows } = await client.query(
    `SELECT DISTINCT visit_id::bigint AS visit_id
     FROM schedules
     WHERE cycle_id = $1
        OR visit_id_full LIKE 'mock-%'
        OR (visit_id >= 99999000 AND visit_id <= 99999999)
     UNION
     SELECT 99999163
     WHERE EXISTS (SELECT 1 FROM section_state WHERE visit_id = 99999163 LIMIT 1)`,
    [MOCK_CYCLE_ID],
  );
  return rows.map((r) => Number(r.visit_id)).filter((id) => Number.isFinite(id));
}

async function purgeMockHubData(pool = null) {
  const ownPool = !pool;
  const db = pool || require('./db').pool;
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const mockVisitIds = await collectMockVisitIds(client);
    const counts = {
      mockVisitIds: mockVisitIds.length,
      schedules: 0,
      hubStoresCleared: 0,
      hubStoresRemoved: 0,
      testUsersDeactivated: 0,
    };

    if (mockVisitIds.length) {
      for (const table of HUB_VISIT_TABLES) {
        await client.query(
          `DELETE FROM ${table} WHERE visit_id = ANY($1::bigint[])`,
          [mockVisitIds],
        );
      }

      const readRes = await client.query(
        `DELETE FROM hub_message_reads
         WHERE thread_id IN (
           SELECT id FROM hub_message_threads WHERE visit_id = ANY($1::bigint[])
         )`,
        [mockVisitIds],
      );
      counts.messageReads = readRes.rowCount || 0;

      const msgRes = await client.query(
        `DELETE FROM hub_messages
         WHERE thread_id IN (
           SELECT id FROM hub_message_threads WHERE visit_id = ANY($1::bigint[])
         )`,
        [mockVisitIds],
      );
      counts.messages = msgRes.rowCount || 0;

      const threadDel = await client.query(
        'DELETE FROM hub_message_threads WHERE visit_id = ANY($1::bigint[])',
        [mockVisitIds],
      );
      counts.messageThreads = threadDel.rowCount || 0;
    }

    const schedRes = await client.query(
      `DELETE FROM schedules
       WHERE cycle_id = $1
          OR visit_id_full LIKE 'mock-%'
          OR (visit_id >= 99999000 AND visit_id <= 99999999)`,
      [MOCK_CYCLE_ID],
    );
    counts.schedules = schedRes.rowCount || 0;

    if (mockVisitIds.length) {
      const hubClear = await client.query(
        `UPDATE hub_stores
         SET default_visit_id = NULL,
             live_visit_id = NULL,
             live_visit_pinned_at = NULL,
             live_visit_pinned_by = NULL,
             is_test = FALSE
         WHERE default_visit_id = ANY($1::bigint[])
            OR live_visit_id = ANY($1::bigint[])
            OR is_test = TRUE`,
        [mockVisitIds],
      );
      counts.hubStoresCleared = hubClear.rowCount || 0;
    } else {
      const hubClear = await client.query(
        `UPDATE hub_stores
         SET default_visit_id = NULL,
             live_visit_id = NULL,
             live_visit_pinned_at = NULL,
             live_visit_pinned_by = NULL,
             is_test = FALSE
         WHERE is_test = TRUE`,
      );
      counts.hubStoresCleared = hubClear.rowCount || 0;
    }

    const testUsers = await client.query(
      `UPDATE hub_users
       SET is_active = FALSE
       WHERE lower(email) LIKE '%@test.local'
          OR lower(email) IN (
            'hub.rep.a@test.local',
            'hub.rep.b@test.local',
            'hub.lead@test.local'
          )`,
    );
    counts.testUsersDeactivated = testUsers.rowCount || 0;

    await client.query('COMMIT');
    return counts;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    if (ownPool) await db.end().catch(() => {});
  }
}

module.exports = {
  MOCK_CYCLE_ID,
  purgeMockHubData,
};
