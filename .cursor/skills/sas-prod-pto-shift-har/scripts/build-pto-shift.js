#!/usr/bin/env node
'use strict';

/**
 * Build and complete a Fred Meyer PTO/admin shift in SAS PROD.
 *
 * Usage:
 *   node build-pto-shift.js --employee "Alexandra Wright" --date 2026-06-17 --exception sick --dry-run
 *   node build-pto-shift.js --employee "Alexandra Wright" --date 2026-06-17 --exception vacation --hours 8
 *
 * HAR: sas-har-20260617-150709.json (see reference/har-evidence-20260617.json)
 */

const fs = require('fs');
const C = require('./pto-constants');
const { filterVisitsByStore, getVisitStoreNumber, storesMatch } = require('../../sas-prod-shift-management-har/scripts/sas-store-match');

const DEFAULT_STATE = 'C:/Users/tgaut/sas-auth/.sas-session/auth-state.json';
const BASE_V1 = 'https://prod.sasretail.com/api/v1';
const BASE_V2 = 'https://prod.sasretail.com/api/v2';

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    complete: true,
    projectId: C.DEFAULT_PROJECT_ID,
    storeNumber: C.DEFAULT_STORE_NUMBER,
    teamId: C.DEFAULT_TEAM_ID,
    shiftStart: C.DEFAULT_SHIFT_START,
    shiftEnd: C.DEFAULT_SHIFT_END,
    scheduledEndTime: C.DEFAULT_SCHEDULED_END_TIME,
    hours: 8,
    timeChangeReason: C.DEFAULT_TIME_CHANGE_REASON,
    timeChangeComment: C.DEFAULT_TIME_CHANGE_COMMENT,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--no-complete') opts.complete = false;
    else if (arg === '--date') opts.date = argv[++i];
    else if (arg === '--employee') opts.employeeName = argv[++i];
    else if (arg === '--exception') opts.exception = argv[++i];
    else if (arg === '--hours') opts.hours = Number(argv[++i]);
    else if (arg === '--shift-start') opts.shiftStart = argv[++i];
    else if (arg === '--shift-end') opts.shiftEnd = argv[++i];
    else if (arg === '--time-change-reason') opts.timeChangeReason = Number(argv[++i]);
    else if (arg === '--time-change-comment') opts.timeChangeComment = argv[++i];
    else if (arg === '--help' || arg === '-h') opts.help = true;
  }
  return opts;
}

function usage() {
  console.log(`Usage:
  node build-pto-shift.js --employee "Name" --date YYYY-MM-DD --exception sick|holiday|vacation|bereavement|jury_duty [--hours N] [--dry-run] [--no-complete]

Defaults: project ${C.DEFAULT_PROJECT_ID}, store ${C.DEFAULT_STORE_NUMBER}, team PTO, mileage off, employee is lead.`);
}

function loadSession() {
  const statePath = process.env.SAS_AUTH_STATE || DEFAULT_STATE;
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const token = state?.auth?.auth_token;
  if (!token) throw new Error(`No auth_token in ${statePath}`);
  return {
    token: String(token),
    csrf: state.csrfToken || state.cookies?.csrftoken || '',
    cookieHeader: state.cookieHeader || '',
  };
}

const rows = (d) => (Array.isArray(d) ? d : d?.results || []);
const empName = (e) => e.person?.person_name || e.person_name || '';

function parseDisplayTime(value) {
  const m = String(value || '').trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) throw new Error(`Invalid display time: ${value}`);
  let hour = Number(m[1]);
  const min = m[2];
  const ampm = m[3].toUpperCase();
  if (ampm === 'PM' && hour !== 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${min}:00`;
}

function isoFromLocal(dateIso, displayTime, offsetMinutes = 420) {
  const [y, m, d] = dateIso.split('-').map(Number);
  const [hour, min, sec = 0] = parseDisplayTime(displayTime).split(':').map(Number);
  const utcMs = Date.UTC(y, m - 1, d, hour, min, sec) + offsetMinutes * 60 * 1000;
  return new Date(utcMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function addHoursToDisplay(dateIso, displayTime, hours, offsetMinutes = 420) {
  const startIso = isoFromLocal(dateIso, displayTime, offsetMinutes);
  const endMs = Date.parse(startIso) + hours * 60 * 60 * 1000;
  return new Date(endMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function displayEndFromHours(dateIso, startDisplay, hours) {
  const start = parseDisplayTime(startDisplay);
  const [h, m] = start.split(':').map(Number);
  const totalMin = h * 60 + m + Math.round(hours * 60);
  const endH24 = Math.floor(totalMin / 60) % 24;
  const endMin = totalMin % 60;
  const ampm = endH24 >= 12 ? 'PM' : 'AM';
  let hour12 = endH24 % 12;
  if (hour12 === 0) hour12 = 12;
  return `${String(hour12).padStart(2, '0')}:${String(endMin).padStart(2, '0')} ${ampm}`;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help || !opts.employeeName || !opts.date || !opts.exception) {
    usage();
    process.exit(opts.help ? 0 : 1);
  }

  const breakReason = C.BREAK_REASONS[String(opts.exception).toLowerCase()];
  if (!breakReason) {
    throw new Error(`Unknown exception ${opts.exception}. Use: ${Object.keys(C.BREAK_REASONS).join(', ')}`);
  }

  const session = loadSession();
  async function sas(base, method, apiPath, body) {
    const headers = {
      Accept: 'application/json',
      Authorization: `Token ${session.token}`,
      'X-Requested-With': 'XMLHttpRequest',
    };
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      if (session.csrf) headers['X-CSRFToken'] = session.csrf;
      if (session.cookieHeader) headers.Cookie = session.cookieHeader;
    }
    const res = await fetch(base + apiPath, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      throw new Error(`${method} ${apiPath} ${res.status}: ${String(text).slice(0, 400)}`);
    }
    return data;
  }

  const sasV1 = (method, path, body) => sas(BASE_V1, method, path, body);
  const sasV2 = (method, path, body) => sas(BASE_V2, method, path, body);

  async function searchEmployee(name) {
    const q = encodeURIComponent(`"${name}"`);
    const data = await sasV1(
      'GET',
      `/human-resources/workday-employees/?address_verified=true&fields=id,person_name,workday_given_id,person&page_size=10&q=${q}&sort=person__person_name`
    );
    const list = rows(data);
    const needle = name.toLowerCase();
    return (
      list.find((e) => empName(e).toLowerCase() === needle) ||
      list.find((e) => empName(e).toLowerCase().includes(needle)) ||
      list[0] ||
      null
    );
  }

  async function resolveCycle(projectId, dateIso) {
    const cycles = rows(
      await sasV1(
        'GET',
        `/projects/project-cycles/?current_status=active&page=1&page_size=100&project=${projectId}&sort=start_date`
      )
    );
    const cycle = cycles.find(
      (c) => String(c.start_date) <= dateIso && String(c.end_date) >= dateIso
    );
    if (!cycle) throw new Error(`No active cycle for project ${projectId} on ${dateIso}`);
    return cycle;
  }

  async function resolveProjectStore(projectId, storeNumber) {
    const stores = rows(
      await sasV1('GET', `/projects/project-stores-autocomplete/?limit=1000&project=${projectId}`)
    );
    const match = stores.find((s) => storesMatch(s.store?.number, storeNumber));
    if (!match) throw new Error(`Store ${storeNumber} not on project ${projectId}`);
    return match;
  }

  async function findExistingVisit(cycleId, dateIso, storeNumber) {
    const visits = rows(
      await sasV1('GET', `/team-scheduling/visits/?cycle=${cycleId}&page=1&page_size=500`)
    );
    const sameDay = visits.filter((v) => String(v.scheduled_date) === dateIso);
    return filterVisitsByStore(sameDay, storeNumber);
  }

  const employee = await searchEmployee(opts.employeeName);
  if (!employee) throw new Error(`Could not resolve employee: ${opts.employeeName}`);

  const cycle = await resolveCycle(opts.projectId, opts.date);
  const projectStore = await resolveProjectStore(opts.projectId, opts.storeNumber);
  const endDisplay = opts.hours === 8 ? opts.shiftEnd : displayEndFromHours(opts.date, opts.shiftStart, opts.hours);
  const startIso = isoFromLocal(opts.date, opts.shiftStart);
  const endIso = addHoursToDisplay(opts.date, opts.shiftStart, opts.hours);

  const plan = {
    projectId: opts.projectId,
    cycleId: cycle.id,
    cycleName: cycle.name,
    storeNumber: opts.storeNumber,
    projectStoreId: projectStore.id,
    teamId: opts.teamId,
    date: opts.date,
    employee: { id: employee.id, name: empName(employee) },
    exception: opts.exception,
    breakReasonId: breakReason,
    shiftStart: opts.shiftStart,
    shiftEnd: endDisplay,
    hours: opts.hours,
    startIso,
    endIso,
    complete: opts.complete,
    dryRun: opts.dryRun,
  };

  console.log('PTO shift plan:', JSON.stringify(plan, null, 2));

  const existing = await findExistingVisit(cycle.id, opts.date, opts.storeNumber);
  if (existing.length) {
    console.log(
      `Warning: ${existing.length} existing visit(s) for store ${opts.storeNumber} on ${opts.date}:`,
      existing.map((v) => ({ visitId: v.id, store: getVisitStoreNumber(v), status: v.current_status }))
    );
  }

  if (opts.dryRun) {
    console.log('Dry-run only — no mutations.');
    return;
  }

  const visitBody = {
    cycle: cycle.id,
    store: projectStore.id,
    team: opts.teamId,
    scheduled_date: opts.date,
    shift_start_time: opts.shiftStart,
    shift_end_time: endDisplay,
    scheduled_end_time: opts.scheduledEndTime,
    estimated_shift_hours: String(Number(opts.hours).toFixed(2)),
    current_status: 'active',
  };

  const visit = await sasV1('POST', '/team-scheduling/visits/', visitBody);
  console.log('Created visit', visit.id, 'store', getVisitStoreNumber(visit));

  const shiftBody = {
    home_to_store: false,
    store_to_store: false,
    store_to_home: false,
    calculate_mileage: false,
    visit: String(visit.id),
    employee: Number(employee.id),
    cycle: Number(cycle.id),
    shift_start_time: opts.shiftStart,
    shift_end_time: endDisplay,
    current_status: 'active',
    rate_type: {},
    device_reimbursement: false,
    is_lead: 'true',
  };

  const shift = await sasV1('POST', '/team-scheduling/shifts/', shiftBody);
  console.log('Created shift', shift.id, 'for', empName(shift.employee || employee));

  if (!opts.complete) {
    console.log('Skipping field-data start/complete (--no-complete).');
    return;
  }

  await sasV1('PATCH', `/field-app/visits/${visit.id}/`, {});
  console.log('Started visit in field data');

  await sasV2('POST', `/field-app/travel/${shift.id}/to_store/`, {});
  console.log('Posted travel/to_store');

  const actualStart = parseDisplayTime(opts.shiftStart);
  const actualEnd = parseDisplayTime(endDisplay);
  const v2Body = {
    actual_start_date: opts.date,
    actual_start_time: actualStart,
    actual_end_date: opts.date,
    actual_end_time: actualEnd,
    no_show: false,
    shift_breaks: [
      {
        reason: breakReason,
        start_time: startIso,
        end_time: endIso,
        time_change_reason: opts.timeChangeReason,
        time_change_comment: opts.timeChangeComment,
      },
    ],
    time_change_reason: opts.timeChangeReason,
    time_change_comment: opts.timeChangeComment,
  };

  await sasV2('PATCH', `/field-app/shifts/${shift.id}/`, v2Body);
  console.log('Applied exception hours via v2 shift PATCH');

  await sasV1('PUT', `/field-app/visits/${visit.id}/shift-complete/`, {});
  await sasV1('PATCH', `/field-app/visits/${visit.id}/shift-complete/`, {});
  console.log('Completed visit');

  const verify = await sasV1('GET', `/field-app/visits/${visit.id}/shift-complete/`);
  console.log('Verify:', JSON.stringify({
    visitId: visit.id,
    shiftId: shift.id,
    status: verify.current_status,
    employee: verify.employees?.[0]?.name,
    breaks: verify.employees?.[0]?.shift_breaks?.map((b) => b.reason?.text || b.reason),
    actualStart: verify.employees?.[0]?.actual_start_time,
    actualEnd: verify.employees?.[0]?.actual_end_time,
  }, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
