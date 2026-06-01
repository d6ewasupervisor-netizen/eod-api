#!/usr/bin/env node
/**
 * Pull Kompass cycle visits from prod.sasretail.com and compare with hub DB.
 *
 *   node scripts/audit-blitz-visits-from-prod.js [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *
 * Reads SAS session from ../sas-auth/.sas-session/auth-state.json (or SAS_AUTH_STATE).
 * Requires DATABASE_URL for hub/schedules comparison.
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

function loadSession() {
  const statePath = process.env.SAS_AUTH_STATE || DEFAULT_STATE;
  if (!fs.existsSync(statePath)) {
    throw new Error(`Missing SAS auth state: ${statePath}`);
  }
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const token = state.auth?.auth_token;
  if (!state.cookieHeader || !state.csrfToken) {
    throw new Error('SAS auth state missing cookieHeader/csrfToken');
  }
  return { state, token };
}

function headers(session) {
  const h = {
    Accept: 'application/json',
    Cookie: session.state.cookieHeader,
    'X-CSRFToken': session.state.csrfToken,
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

function pickCycle(cycles, from, to) {
  const fromMs = new Date(`${from}T00:00:00`).getTime();
  const toMs = new Date(`${to}T23:59:59`).getTime();
  return cycles.filter((c) => {
    const start = new Date(`${c.start_date}T00:00:00`).getTime();
    const end = new Date(`${c.end_date}T23:59:59`).getTime();
    return start <= toMs && end >= fromMs;
  });
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

  console.log(`[audit] PROD window ${from} .. ${to} (${fixtureStores.size} fixture stores)`);

  const cycles = await fetchCycles(session);
  const matched = pickCycle(cycles, from, to);
  if (!matched.length) {
    console.error('[audit] No active Kompass cycles overlap window');
    console.log('Available cycles:', cycles.map((c) => `${c.id} ${c.name} ${c.start_date}-${c.end_date}`).join('\n'));
    process.exit(1);
  }

  console.log('[audit] Matching cycles:');
  for (const c of matched) {
    console.log(`  ${c.id}  ${c.name}  ${c.start_date} → ${c.end_date}`);
  }

  const cycleIds = matched.map((c) => c.id);
  const visitRows = [];
  for (const cycleId of cycleIds) {
    const visits = await fetchVisitsForCycle(session, cycleId);
    for (const v of visits) {
      if (!['active', 'in-progress'].includes(String(v.current_status || ''))) continue;
      const d = String(v.scheduled_date || '');
      if (d < from || d > to) continue;
      const sn = storeNum(v);
      if (!fixtureStores.has(sn)) continue;
      visitRows.push({
        storeNumber: sn,
        date: d,
        visitId: Number(v.id),
        status: v.current_status,
        lead: v.visit_lead?.person_name || v.visit_lead_name || null,
      });
    }
  }

  const prodByStoreDate = new Map();
  for (const row of visitRows) {
    prodByStoreDate.set(`${row.storeNumber}|${row.date}`, row);
  }

  const prodRows = [...prodByStoreDate.values()].sort((a, b) =>
    a.date.localeCompare(b.date) || Number(a.storeNumber) - Number(b.storeNumber),
  );

  console.log(`\n[audit] PROD visits for fixture stores (${prodRows.length} store-days):`);
  for (const row of prodRows) {
    console.log(
      `  ${row.date}  store ${row.storeNumber.padStart(3, ' ')}  visit ${row.visitId}  ${row.status}${row.lead ? `  lead=${row.lead}` : ''}`,
    );
  }

  if (!process.env.DATABASE_URL) {
    console.log('\n[audit] DATABASE_URL not set — skipping DB comparison');
    await pool.end().catch(() => {});
    return;
  }

  const { rows: dbSchedules } = await query(
    `SELECT visit_id, store_number::text AS store_number, scheduled_date::text AS scheduled_date,
            visit_lead, supervisor
     FROM schedules
     WHERE scheduled_date BETWEEN $1::date AND $2::date
     ORDER BY scheduled_date, store_number::int`,
    [from, to],
  );

  const { rows: hubStores } = await query(
    `SELECT store_number, default_visit_id, name FROM hub_stores ORDER BY store_number::int`,
  );
  const hubByStore = new Map(hubStores.map((r) => [String(Number(r.store_number)), r]));

  const tomorrowOnly = from;
  const { rows: tomorrowHub } = await query(
    `SELECT hs.store_number, hs.default_visit_id, hs.name,
            s.visit_id AS schedule_visit_id, s.visit_lead, s.scheduled_date::text AS scheduled_date
     FROM hub_stores hs
     LEFT JOIN LATERAL (
       SELECT visit_id, visit_lead, scheduled_date
       FROM schedules
       WHERE store_number::text = hs.store_number
         AND scheduled_date = $1::date
       ORDER BY visit_id DESC
       LIMIT 1
     ) s ON TRUE
     WHERE hs.default_visit_id IS NOT NULL
     ORDER BY hs.store_number::int`,
    [tomorrowOnly],
  );

  console.log(`\n[audit] Hub default_visit_id vs schedule for ${tomorrowOnly}:`);
  let tomorrowOk = 0;
  let tomorrowMismatch = 0;
  let tomorrowNoSchedule = 0;
  for (const row of tomorrowHub) {
    const sn = String(Number(row.store_number));
    if (!fixtureStores.has(sn)) continue;
    const def = Number(row.default_visit_id);
    const sched = row.schedule_visit_id != null ? Number(row.schedule_visit_id) : null;
    if (!sched) {
      tomorrowNoSchedule += 1;
      continue;
    }
    if (def === sched) {
      tomorrowOk += 1;
      console.log(`  OK   store ${sn}  visit ${def}  lead=${row.visit_lead || '—'}`);
    } else {
      tomorrowMismatch += 1;
      console.log(
        `  MISMATCH store ${sn}  hub=${def}  schedule=${sched}  lead=${row.visit_lead || '—'}`,
      );
    }
  }
  console.log(
    `[audit] Tomorrow summary: ok=${tomorrowOk} mismatch=${tomorrowMismatch} hub-only-no-sched=${tomorrowNoSchedule}`,
  );

  console.log('\n[audit] Fixture stores scheduled later in week (PROD, not tomorrow):');
  for (const row of prodRows) {
    if (row.date === tomorrowOnly) continue;
    const hub = hubByStore.get(String(Number(row.storeNumber)));
    const hubVisit = hub?.default_visit_id != null ? Number(hub.default_visit_id) : null;
    const flag = hubVisit === row.visitId ? 'OK' : (hubVisit === Number(prodRows.find((p) => p.storeNumber === row.storeNumber && p.date === tomorrowOnly)?.visitId) ? 'STALE-TOMORROW' : 'NEEDS-UPDATE');
    console.log(
      `  ${row.date}  store ${row.storeNumber}  prod visit ${row.visitId}  hub default ${hubVisit ?? '—'}  ${flag}`,
    );
  }

  const missingFromProd = [...fixtureStores].filter((sn) =>
    !prodRows.some((r) => r.storeNumber === sn),
  );
  if (missingFromProd.length) {
    console.log(`\n[audit] Fixture stores with NO PROD visit in window: ${missingFromProd.join(', ')}`);
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error('[audit] Failed:', err.response?.status, err.response?.data || err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
