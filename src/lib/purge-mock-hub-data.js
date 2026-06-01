// Purge mock hub data and keep fixture-store schedules blitz-week only.

const fs = require('fs');
const path = require('path');
const { BLITZ_PROJECT_ID } = require('./hub-blitz-config');
const { remainderOfWeekWindow } = require('./hub-supervisor-resolve');

const MOCK_CYCLE_ID = 242292;
const FIXTURES_DIR = path.join(__dirname, '../data/hub-fixtures');
const TEST_STORE_NUMBER = '163';
const TEST_VISIT_ID = 99999163;

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

function listFixtureStoreNumbers() {
  if (!fs.existsSync(FIXTURES_DIR)) return [];
  return fs.readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
}

async function collectMockVisitIds(client) {
  const { rows } = await client.query(
    `SELECT DISTINCT visit_id::bigint AS visit_id
     FROM schedules
     WHERE cycle_id = $1
        OR visit_id_full LIKE 'mock-%'
        OR (visit_id >= 99999000 AND visit_id <= 99999999)
     UNION SELECT $2::bigint`,
    [MOCK_CYCLE_ID, TEST_VISIT_ID],
  );
  return rows.map((r) => Number(r.visit_id)).filter((id) => Number.isFinite(id));
}

async function removeHubTestStore163(client) {
  const counts = {
    assignmentsRemoved: 0,
    hubStoreNormalized: 0,
    testSectionsRemoved: 0,
  };

  const assignRes = await client.query(
    'DELETE FROM hub_store_assignments WHERE store_number = $1',
    [TEST_STORE_NUMBER],
  );
  counts.assignmentsRemoved = assignRes.rowCount || 0;

  const hubRes = await client.query(
    `UPDATE hub_stores
     SET name = 'FM 163',
         is_test = FALSE,
         default_visit_id = NULL,
         live_visit_id = NULL,
         live_visit_pinned_at = NULL,
         live_visit_pinned_by = NULL
     WHERE store_number = $1`,
    [TEST_STORE_NUMBER],
  );
  counts.hubStoreNormalized = hubRes.rowCount || 0;

  const sectionRes = await client.query(
    'DELETE FROM section_state WHERE visit_id = $1',
    [TEST_VISIT_ID],
  );
  counts.testSectionsRemoved = sectionRes.rowCount || 0;

  return counts;
}

async function purgeStaleFixtureSchedules(client, options = {}) {
  const week = remainderOfWeekWindow();
  const from = options.from || week.from;
  const to = options.to || week.to;
  const projectId = options.projectId ?? BLITZ_PROJECT_ID;
  const fixtureStores = options.fixtureStores || listFixtureStoreNumbers();
  const numericIds = fixtureStores
    .map((sn) => Number(sn))
    .filter((n) => Number.isFinite(n));

  if (!numericIds.length) {
    return { staleSchedulesRemoved: 0, from, to, projectId };
  }

  const nonFixtureRes = await client.query(
    `DELETE FROM schedules
     WHERE project_id = $1
       AND store_number IS NOT NULL
       AND NOT (store_number = ANY($2::int[]))`,
    [projectId, numericIds],
  );

  const { rowCount } = await client.query(
    `DELETE FROM schedules
     WHERE store_number = ANY($1::int[])
       AND (
         project_id IS DISTINCT FROM $2
         OR scheduled_date < $3::date
         OR scheduled_date > $4::date
       )`,
    [numericIds, projectId, from, to],
  );

  return {
    staleSchedulesRemoved: (rowCount || 0) + (nonFixtureRes.rowCount || 0),
    nonFixtureSchedulesRemoved: nonFixtureRes.rowCount || 0,
    from,
    to,
    projectId,
  };
}

async function purgeMockHubData(pool = null, options = {}) {
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
          OR (visit_id >= 99999000 AND visit_id <= 99999999)
          OR visit_id = $2`,
      [MOCK_CYCLE_ID, TEST_VISIT_ID],
    );
    counts.schedules = schedRes.rowCount || 0;

    const hubClear = await client.query(
      `UPDATE hub_stores
       SET default_visit_id = NULL,
           live_visit_id = NULL,
           live_visit_pinned_at = NULL,
           live_visit_pinned_by = NULL,
           is_test = FALSE
       WHERE is_test = TRUE
          OR default_visit_id = ANY($1::bigint[])
          OR live_visit_id = ANY($1::bigint[])`,
      [mockVisitIds.length ? mockVisitIds : [TEST_VISIT_ID]],
    );
    counts.hubStoresCleared = hubClear.rowCount || 0;

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

    counts.testStore163 = await removeHubTestStore163(client);

    if (options.purgeStaleSchedules !== false) {
      counts.staleSchedules = await purgeStaleFixtureSchedules(client, options);
    }

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
  BLITZ_PROJECT_ID,
  TEST_STORE_NUMBER,
  TEST_VISIT_ID,
  listFixtureStoreNumbers,
  removeHubTestStore163,
  purgeStaleFixtureSchedules,
  purgeMockHubData,
};
