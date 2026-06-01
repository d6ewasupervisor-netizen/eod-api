#!/usr/bin/env node
/**
 * Sync hub_stores + section_state from prod.sasretail.com cycle management.
 *
 *   node scripts/sync-checklane-visits-from-prod.js [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--dry-run]
 *
 * For each checklane fixture store, uses the earliest active/in-progress PROD visit
 * in the date window and sets hub_stores.default_visit_id to that visit id.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { query, pool } = require('../src/lib/db');

const BASE = 'https://prod.sasretail.com';
const KOMPASS_PROJECT_ID = Number(process.env.CHECKLANES_BLITZ_PROJECT_ID || 1715);
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

async function sasGet(session, urlPath) {
  const resp = await axios.get(`${BASE}${urlPath}`, { headers: headers(session) });
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
    `/api/v1/projects/project-cycles/?current_status=active&page=1&page_size=100&project=${KOMPASS_PROJECT_ID}&sort=start_date`,
  );
  return normalizeList(data);
}

async function fetchVisitsForCycle(session, cycleId) {
  const all = [];
  let page = 1;
  while (page <= 20) {
    const data = await sasGet(
      session,
      `/api/v1/team-scheduling/visits/?cycle=${cycleId}&page=${page}&page_size=500`,
    );
    const rows = normalizeList(data);
    all.push(...rows);
    if (rows.length < 500) break;
    page += 1;
  }
  return all;
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

async function upsertScheduleFromVisit(visit, cycleId) {
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
       'Fred Meyer Blitz Kompass ISE', $6, $7, $8,
       $9, $10, $11, $12,
       'tyson.gauthier@retailodyssey.com', NOW()
     )
     ON CONFLICT (visit_id, scheduled_date) DO UPDATE SET
       store_number = EXCLUDED.store_number,
       store_name = EXCLUDED.store_name,
       cycle_id = EXCLUDED.cycle_id,
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
      KOMPASS_PROJECT_ID,
      visit.scheduled_date,
      visit.shift_start_time || null,
      visit.shift_end_time || null,
      visit.total_hours != null ? String(visit.total_hours) : null,
      visit.current_status || 'active',
      leadName,
    ],
  );
}

async function main() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const from = parseArg('--from', tomorrow.toISOString().slice(0, 10));
  const toDate = new Date(from);
  toDate.setDate(toDate.getDate() + 6);
  const to = parseArg('--to', toDate.toISOString().slice(0, 10));

  const fixtureStores = new Set(listFixtureStores());
  const session = loadSession();

  const cycles = await fetchCycles(session);
  const matchedCycles = pickCycles(cycles, from, to);
  if (!matchedCycles.length) throw new Error('No Kompass cycles overlap window');

  console.log(`[sync] PROD cycles: ${matchedCycles.map((c) => `${c.id} (${c.start_date}→${c.end_date})`).join(', ')}`);

  const visitRows = [];
  for (const cycle of matchedCycles) {
    const visits = await fetchVisitsForCycle(session, cycle.id);
    for (const v of visits) {
      if (!['active', 'in-progress'].includes(String(v.current_status || ''))) continue;
      const d = String(v.scheduled_date || '');
      if (d < from || d > to) continue;
      const sn = storeNum(v);
      if (!fixtureStores.has(sn)) continue;
      visitRows.push({ ...v, _cycleId: cycle.id, _storeNumber: sn });
    }
  }

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

  console.log(`[sync] ${earliestByStore.size} fixture stores with PROD visits in ${from}..${to}`);
  let updated = 0;
  let sections = 0;
  let schedules = 0;

  for (const [storeNumber, visit] of [...earliestByStore.entries()].sort(
    (a, b) => Number(a[0]) - Number(b[0]),
  )) {
    const visitId = Number(visit.id);
    const prev = hubMap.get(storeNumber);
    const changed = prev !== visitId;
    console.log(
      `  store ${storeNumber}  ${visit.scheduled_date}  visit ${visitId}`
      + `${changed ? (prev ? `  (was ${prev})` : '') : '  unchanged'}`,
    );

    if (!DRY_RUN) {
      if (changed) {
        await query(
          `INSERT INTO hub_stores (store_number, name, default_visit_id, is_test)
           VALUES ($1, $2, $3, FALSE)
           ON CONFLICT (store_number) DO UPDATE SET default_visit_id = EXCLUDED.default_visit_id`,
          [storeNumber, visit.store?.store?.name || `FM ${storeNumber}`, visitId],
        );
        updated += 1;
      }
      sections += await seedSections(visitId, storeNumber);
      await upsertScheduleFromVisit(visit, visit._cycleId);
      schedules += 1;
    }
  }

  const missing = [...fixtureStores].filter((sn) => !earliestByStore.has(sn));
  let cleared = 0;
  if (missing.length) {
    console.log(`[sync] No blitz visit in window — clearing hub default_visit_id:`);
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

  const tomorrowDate = from;
  console.log(`\n[sync] Tomorrow (${tomorrowDate}) PROD blitz stores:`);
  for (const v of visitRows.filter((x) => x.scheduled_date === tomorrowDate)) {
    const sn = v._storeNumber;
    const hubVisit = hubMap.get(sn);
    const newVisit = Number(v.id);
    console.log(`  store ${sn}  visit ${newVisit}  lead=${v.visit_lead?.person_name || '—'}`);
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
