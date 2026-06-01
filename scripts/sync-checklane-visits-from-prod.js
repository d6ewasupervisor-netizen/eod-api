#!/usr/bin/env node
/**
 * Sync hub_stores + schedules from prod.sasretail.com blitz cycle management.
 *
 *   node scripts/sync-checklane-visits-from-prod.js [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--dry-run]
 *
 * Upserts every active blitz visit in the window into schedules (supervisor resolved
 * via employees + field-data). Sets hub_stores.default_visit_id to each store's
 * earliest upcoming visit on or after --from.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { query, pool } = require('../src/lib/db');
const {
  loadEmployeeLookup,
  resolveHubOverseerEmail,
  remainderOfWeekWindow,
} = require('../src/lib/hub-supervisor-resolve');
const { BLITZ_PROJECT_ID, BLITZ_PROJECT_NAME } = require('../src/lib/hub-blitz-config');
const { purgeStaleFixtureSchedules } = require('../src/lib/purge-mock-hub-data');

const BASE = 'https://prod.sasretail.com';
const KOMPASS_PROJECT_ID = BLITZ_PROJECT_ID;
const FIXTURES_DIR = path.join(__dirname, '../src/data/hub-fixtures');
const DEFAULT_STATE = path.join(__dirname, '../../sas-auth/.sas-session/auth-state.json');
const DRY_RUN = process.argv.includes('--dry-run');

function parseArg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

function listFixtureStores() {
  return fs.readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
}

function loadFixtures(storeNumber) {
  const p = path.join(FIXTURES_DIR, `${storeNumber}.json`);
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, 'utf8')).fixtures || [];
}

function loadSession() {
  const statePath = process.env.SAS_AUTH_STATE || DEFAULT_STATE;
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  return {
    cookieHeader: state.cookieHeader,
    csrfToken: state.csrfToken,
    token: state.auth?.auth_token,
  };
}

function headers(session) {
  const h = {
    Accept: 'application/json',
    Cookie: session.cookieHeader,
    'X-CSRFToken': session.csrfToken,
    'X-Requested-With': 'XMLHttpRequest',
    Referer: `${BASE}/en/sasretail/dashboard/`,
  };
  if (session.token) h.Authorization = `Token ${session.token}`;
  return h;
}

function normalizeList(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.results)) return body.results;
  return [];
}

async function sasGet(session, urlPath, params) {
  const qs = params
    ? `?${new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString()}`
    : '';
  const resp = await axios.get(`${BASE}${urlPath}${qs}`, { headers: headers(session) });
  return resp.data;
}

function storeNum(visit) {
  return visit?.store?.store?.number != null
    ? String(Number(visit.store.store.number))
    : '';
}

async function fetchCycles(session) {
  const data = await sasGet(
    session,
    '/api/v1/projects/project-cycles/',
    {
      current_status: 'active',
      page: '1',
      page_size: '100',
      project: String(KOMPASS_PROJECT_ID),
      sort: 'start_date',
    },
  );
  return normalizeList(data);
}

async function fetchVisitsForCycle(session, cycleId) {
  const all = [];
  let page = 1;
  while (page <= 20) {
    const data = await sasGet(
      session,
      '/api/v1/team-scheduling/visits/',
      { cycle: String(cycleId), page: String(page), page_size: '500' },
    );
    const rows = normalizeList(data);
    all.push(...rows);
    if (rows.length < 500) break;
    page += 1;
  }
  return all;
}

async function fetchFieldDataSupervisors(session, from, to) {
  const byVisitId = new Map();
  let page = 1;
  while (page <= 30) {
    const data = await sasGet(
      session,
      '/api/v1/operations/field-data/',
      {
        customer_id: '2',
        scheduled_dt_from: from,
        scheduled_dt_to: to,
        merchandiser: '',
        supervisor_id: '',
        project_id: String(KOMPASS_PROJECT_ID),
        page: String(page),
        page_size: '500',
      },
    );
    const rows = normalizeList(data);
    for (const row of rows) {
      if (row.id != null && row.supervisor) {
        byVisitId.set(Number(row.id), row.supervisor);
      }
    }
    if (rows.length < 500) break;
    page += 1;
  }
  return byVisitId;
}

function visitProjectId(visit) {
  const raw = visit?.project?.project_id
    ?? visit?.project?.id
    ?? visit?.project_id;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

async function clearBlitzSchedulesInWindow(fixtureStoreNumbers, from, to) {
  const numericIds = fixtureStoreNumbers.map((sn) => Number(sn)).filter((n) => Number.isFinite(n));
  if (!numericIds.length) return 0;
  const { rowCount } = await query(
    `DELETE FROM schedules
     WHERE project_id = $1
       AND scheduled_date >= $2::date
       AND scheduled_date <= $3::date
       AND store_number = ANY($4::int[])`,
    [BLITZ_PROJECT_ID, from, to, numericIds],
  );
  return rowCount || 0;
}

function pickCycles(cycles, from, to) {
  const fromMs = new Date(`${from}T00:00:00`).getTime();
  const toMs = new Date(`${to}T23:59:59`).getTime();
  return cycles.filter((c) => {
    const start = new Date(`${c.start_date}T00:00:00`).getTime();
    const end = new Date(`${c.end_date}T23:59:59`).getTime();
    return start <= toMs && end >= fromMs;
  });
}

async function seedSections(visitId, storeNumber) {
  const fixtures = loadFixtures(storeNumber);
  const manifest = fixtures.filter((f) => f.on_manifest && f.dbkey);
  let inserted = 0;
  for (const f of manifest) {
    const { rowCount } = await query(
      `INSERT INTO section_state (visit_id, lane, dbkey, state)
       VALUES ($1, $2, $3, 'not_started')
       ON CONFLICT (visit_id, lane, dbkey) DO NOTHING`,
      [visitId, f.lane || '', f.dbkey],
    );
    inserted += rowCount || 0;
  }
  return inserted;
}

async function upsertScheduleFromVisit(visit, cycleId, supervisorEmail, fieldSupervisor) {
  const storeNumber = storeNum(visit);
  const leadName = visit.visit_lead?.person_name
    || visit.visit_lead_name
    || null;
  await query(
    `INSERT INTO schedules (
       visit_id, visit_id_full, cycle_id, store_number, store_name,
       project_name, project_id, scheduled_date, shift_start_time,
       shift_end_time, total_hours, current_status, visit_lead,
       supervisor, synced_at
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9, $10, $11, $12, $13,
       $14, NOW()
     )
     ON CONFLICT (visit_id, scheduled_date) DO UPDATE SET
       store_number = EXCLUDED.store_number,
       store_name = EXCLUDED.store_name,
       cycle_id = EXCLUDED.cycle_id,
       project_name = EXCLUDED.project_name,
       project_id = EXCLUDED.project_id,
       shift_start_time = EXCLUDED.shift_start_time,
       shift_end_time = EXCLUDED.shift_end_time,
       current_status = EXCLUDED.current_status,
       visit_lead = EXCLUDED.visit_lead,
       supervisor = EXCLUDED.supervisor,
       synced_at = NOW()`,
    [
      Number(visit.id),
      visit.visit_id || String(visit.id),
      cycleId,
      Number(storeNumber),
      visit.store?.store?.name || `FM ${storeNumber}`,
      BLITZ_PROJECT_NAME,
      KOMPASS_PROJECT_ID,
      visit.scheduled_date,
      visit.shift_start_time || null,
      visit.shift_end_time || null,
      visit.total_hours != null ? String(visit.total_hours) : null,
      visit.current_status || 'active',
      leadName,
      supervisorEmail || fieldSupervisor || null,
    ],
  );
}

async function main() {
  const week = remainderOfWeekWindow();
  const from = parseArg('--from', week.from);
  const to = parseArg('--to', week.to);

  const fixtureStores = new Set(listFixtureStores());
  const session = loadSession();
  const employeeLookup = await loadEmployeeLookup();

  const cycles = await fetchCycles(session);
  const matchedCycles = pickCycles(cycles, from, to);
  if (!matchedCycles.length) throw new Error('No Kompass cycles overlap window');

  console.log(`[sync] Blitz project ${BLITZ_PROJECT_ID} (${BLITZ_PROJECT_NAME})`);
  console.log(`[sync] Window ${from} .. ${to} (remainder of week, PT)`);
  console.log(`[sync] PROD cycles: ${matchedCycles.map((c) => `${c.id} (${c.start_date}→${c.end_date})`).join(', ')}`);

  if (!DRY_RUN) {
    const clearedRows = await clearBlitzSchedulesInWindow([...fixtureStores], from, to);
    console.log(`[sync] Cleared ${clearedRows} existing project-${BLITZ_PROJECT_ID} schedule rows for fixture stores`);
  }

  const fieldSupervisors = await fetchFieldDataSupervisors(session, from, to);
  console.log(`[sync] Field-data supervisors loaded for ${fieldSupervisors.size} visits`);

  const visitRows = [];
  for (const cycle of matchedCycles) {
    const visits = await fetchVisitsForCycle(session, cycle.id);
    for (const v of visits) {
      if (!['active', 'in-progress'].includes(String(v.current_status || ''))) continue;
      const projectId = visitProjectId(v);
      if (projectId != null && projectId !== BLITZ_PROJECT_ID) continue;
      const d = String(v.scheduled_date || '');
      if (d < from || d > to) continue;
      const sn = storeNum(v);
      if (!fixtureStores.has(sn)) continue;
      visitRows.push({ ...v, _cycleId: cycle.id, _storeNumber: sn });
    }
  }

  visitRows.sort((a, b) =>
    String(a.scheduled_date).localeCompare(String(b.scheduled_date))
    || Number(a._storeNumber) - Number(b._storeNumber),
  );

  const earliestByStore = new Map();
  for (const v of visitRows) {
    const sn = v._storeNumber;
    const prev = earliestByStore.get(sn);
    if (!prev || String(v.scheduled_date) < String(prev.scheduled_date)) {
      earliestByStore.set(sn, v);
    }
  }

  const { rows: currentHub } = await query(
    'SELECT store_number, default_visit_id FROM hub_stores',
  );
  const hubMap = new Map(currentHub.map((r) => [String(Number(r.store_number)), Number(r.default_visit_id)]));

  console.log(`[sync] ${visitRows.length} store-days, ${earliestByStore.size} stores with visits`);
  let updated = 0;
  let sections = 0;
  let schedules = 0;

  for (const visit of visitRows) {
    const storeNumber = visit._storeNumber;
    const visitId = Number(visit.id);
    const leadName = visit.visit_lead?.person_name || visit.visit_lead_name || null;
    const fieldSup = fieldSupervisors.get(visitId) || null;
    const supervisorEmail = resolveHubOverseerEmail(
      { supervisorRaw: fieldSup, visitLead: leadName },
      employeeLookup,
    );

    if (!DRY_RUN) {
      await upsertScheduleFromVisit(visit, visit._cycleId, supervisorEmail, fieldSup);
      schedules += 1;
    }

    const earliest = earliestByStore.get(storeNumber);
    if (earliest && Number(earliest.id) === visitId) {
      const prev = hubMap.get(storeNumber);
      const changed = prev !== visitId;
      console.log(
        `  store ${storeNumber}  ${visit.scheduled_date}  visit ${visitId}`
        + `  sup=${supervisorEmail || '—'}`
        + `${changed ? (prev ? `  (was ${prev})` : '') : '  default unchanged'}`,
      );

      if (!DRY_RUN && changed) {
        await query(
          `INSERT INTO hub_stores (store_number, name, default_visit_id, is_test)
           VALUES ($1, $2, $3, FALSE)
           ON CONFLICT (store_number) DO UPDATE SET default_visit_id = EXCLUDED.default_visit_id`,
          [storeNumber, visit.store?.store?.name || `FM ${storeNumber}`, visitId],
        );
        sections += await seedSections(visitId, storeNumber);
        updated += 1;
      }
    }
  }

  const missing = [...fixtureStores].filter((sn) => !earliestByStore.has(sn));
  let cleared = 0;
  if (missing.length) {
    console.log('[sync] No blitz visit in window — clearing hub default_visit_id:');
    for (const sn of missing.sort((a, b) => Number(a) - Number(b))) {
      const prev = hubMap.get(sn);
      if (prev == null) continue;
      console.log(`  store ${sn}  cleared (was ${prev})`);
      if (!DRY_RUN) {
        await query(
          'UPDATE hub_stores SET default_visit_id = NULL WHERE store_number = $1',
          [sn],
        );
        cleared += 1;
      }
    }
  }

  if (!DRY_RUN) {
    const client = await pool.connect();
    try {
      const stale = await purgeStaleFixtureSchedules(client, {
        from,
        to,
        fixtureStores: [...fixtureStores],
      });
      console.log(
        `[sync] Removed ${stale.staleSchedulesRemoved} stale fixture schedules `
        + `(kept project ${BLITZ_PROJECT_ID} ${from}..${to})`,
      );
    } finally {
      client.release();
    }
  }

  console.log(
    `\n[sync] Done dryRun=${DRY_RUN} hubUpdated=${updated} hubCleared=${cleared} `
    + `sectionsInserted=${sections} schedulesUpserted=${schedules}`,
  );
  await pool.end();
}

main().catch(async (err) => {
  console.error('[sync] Failed:', err.response?.status, err.response?.data || err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
