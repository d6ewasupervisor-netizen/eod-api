#!/usr/bin/env node
'use strict';

/**
 * Build a Fred Meyer Admin Holiday visit + roster in SAS PROD (project 147, store 999).
 *
 * Usage:
 *   node build-admin-holiday-shift.js --date 2026-07-04 --lead-id 390965 \
 *     --employee-ids 123477,378144,4354 --dry-run
 *   node build-admin-holiday-shift.js --date 2026-07-04 --lead-id 390965 \
 *     --roster-json ./roster.json
 *
 * roster.json: [{ "id": 390965, "lead": true }, { "id": 123477, "lead": false }, ...]
 *
 * HAR: reference/har-evidence-20260704.json
 */

const fs = require('fs');
const C = require('./admin-holiday-constants');
const {
  filterVisitsByStore,
  assertVisitStore,
  getVisitStoreNumber,
} = require('./sas-store-match');
const {
  buildAdminHolidayVisitBody,
  teamSchedulingReferer,
} = require('./sas-visit-create');

const DEFAULT_STATE = 'C:/Users/tgaut/sas-auth/.sas-session/auth-state.json';
const BASE = 'https://prod.sasretail.com/api/v1';

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    projectId: C.DEFAULT_PROJECT_ID,
    storeNumber: C.DEFAULT_STORE_NUMBER,
    shiftStart: C.DEFAULT_SHIFT_START,
    shiftEnd: C.DEFAULT_SHIFT_END,
    scheduledEndTime: C.DEFAULT_SCHEDULED_END_TIME,
    hours: 8,
    mileageOff: true,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--date') opts.date = argv[++i];
    else if (arg === '--lead-id') opts.leadId = Number(argv[++i]);
    else if (arg === '--employee-ids') {
      opts.employeeIds = String(argv[++i])
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
    } else if (arg === '--roster-json') opts.rosterJson = argv[++i];
    else if (arg === '--shift-start') opts.shiftStart = argv[++i];
    else if (arg === '--shift-end') opts.shiftEnd = argv[++i];
    else if (arg === '--hours') opts.hours = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') opts.help = true;
  }
  return opts;
}

function usage() {
  console.log(`Usage:
  node build-admin-holiday-shift.js --date YYYY-MM-DD --lead-id N \\
    (--employee-ids id1,id2,... | --roster-json path.json) [--shift-start "09:00 AM"] [--shift-end "05:00 PM"] [--dry-run]

Defaults: project ${C.DEFAULT_PROJECT_ID}, store ${C.DEFAULT_STORE_NUMBER}, team ${C.DEFAULT_TEAM_NAME},
mileage off for all shifts, broker_company_id "${C.DEFAULT_BROKER_COMPANY_ID}".

See reference/har-evidence-20260704.json and SKILL.md "Admin Holiday Shift".`);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
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

function loadRoster(opts) {
  if (opts.rosterJson) {
    const list = JSON.parse(fs.readFileSync(opts.rosterJson, 'utf8'));
    if (!Array.isArray(list) || !list.length) throw new Error('roster-json must be a non-empty array');
    return list.map((r) => ({
      id: Number(r.id),
      lead: !!r.lead,
    }));
  }
  if (!opts.employeeIds?.length) throw new Error('Provide --employee-ids or --roster-json');
  if (!opts.leadId) throw new Error('--lead-id is required with --employee-ids');
  const ids = new Set(opts.employeeIds);
  ids.add(opts.leadId);
  return [...ids].map((id) => ({ id, lead: id === opts.leadId }));
}

function shiftBody(visitId, cycleId, employeeId, lead, start, end) {
  return {
    home_to_store: false,
    store_to_store: false,
    store_to_home: false,
    calculate_mileage: false,
    visit: String(visitId),
    employee: Number(employeeId),
    cycle: Number(cycleId),
    shift_start_time: start,
    shift_end_time: end,
    current_status: 'active',
    rate_type: {},
    device_reimbursement: false,
    is_lead: lead ? 'true' : 'false',
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    usage();
    process.exit(0);
  }

  const date = opts.date || todayIso();
  const roster = loadRoster(opts);
  const leads = roster.filter((r) => r.lead);
  if (leads.length !== 1) {
    throw new Error(`Roster must have exactly one lead; found ${leads.length}`);
  }

  const session = loadSession();
  async function sas(method, path, body, cycleIdForReferer) {
    const headers = {
      Accept: 'application/json, text/plain, */*',
      Authorization: `Token ${session.token}`,
      'X-Requested-With': 'XMLHttpRequest',
    };
    if (cycleIdForReferer) {
      headers.Referer = teamSchedulingReferer(cycleIdForReferer);
    }
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json;charset=UTF-8';
      if (session.csrf) headers['X-CSRFToken'] = session.csrf;
      if (session.cookieHeader) headers.Cookie = session.cookieHeader;
    }
    const res = await fetch(BASE + path, {
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
      throw new Error(`${method} ${path} ${res.status}: ${String(text).slice(0, 400)}`);
    }
    return data;
  }

  const cycles = rows(
    await sas(
      'GET',
      `/projects/project-cycles/?current_status=active&page=1&page_size=100&project=${opts.projectId}&sort=start_date`
    )
  );
  const cycle = cycles.find(
    (c) => String(c.start_date) <= date && String(c.end_date) >= date
  );
  if (!cycle) throw new Error(`No active cycle for project ${opts.projectId} on ${date}`);

  const visitBody = buildAdminHolidayVisitBody({
    cycleId: cycle.id,
    scheduledDate: date,
    shiftStartTime: opts.shiftStart,
    shiftEndTime: opts.shiftEnd,
    scheduledEndTime: opts.scheduledEndTime,
    estimatedShiftHours: String(Number(opts.hours).toFixed(2)),
  });

  const existing = filterVisitsByStore(
    rows(
      await sas(
        'GET',
        `/team-scheduling/visits/?cycle=${cycle.id}&page=1&page_size=500`,
        null,
        cycle.id
      )
    ).filter((v) => String(v.scheduled_date) === date),
    opts.storeNumber
  ).filter(
    (v) =>
      v.shift_start_time === opts.shiftStart &&
      v.shift_end_time === opts.shiftEnd &&
      ['active', 'in-progress'].includes(String(v.current_status))
  );

  const plan = {
    projectId: opts.projectId,
    cycleId: cycle.id,
    cycleName: cycle.name,
    storeNumber: opts.storeNumber,
    date,
    shiftWindow: `${opts.shiftStart}-${opts.shiftEnd}`,
    team: C.DEFAULT_TEAM_NAME,
    brokerCompanyId: C.DEFAULT_BROKER_COMPANY_ID,
    visitBody,
    roster,
    reuseVisitId: existing[0]?.id || null,
    dryRun: opts.dryRun,
  };

  console.log('Admin holiday plan:', JSON.stringify(plan, null, 2));

  if (opts.dryRun) {
    console.log('Dry-run only — no mutations.');
    return;
  }

  let visit;
  if (existing.length) {
    visit = await sas('GET', `/team-scheduling/visits/${existing[0].id}/`, null, cycle.id);
    console.log('Reusing visit', visit.id);
  } else {
    visit = await sas('POST', '/team-scheduling/visits/', visitBody, cycle.id);
    console.log('Created visit', visit.id);
  }

  assertVisitStore(visit, opts.storeNumber, 'Target visit');
  if (Number(visit.store?.project?.id) !== opts.projectId) {
    throw new Error(`Visit project ${visit.store?.project?.id} is not ${opts.projectId}`);
  }

  const activeShifts = rows(
    await sas('GET', `/team-scheduling/shifts/?page=1&page_size=50&visit=${visit.id}`, null, cycle.id)
  ).filter((s) => s.current_status === 'active');
  const onVisit = new Set(activeShifts.map((s) => Number(s.employee?.id ?? s.employee)));

  const results = [];
  for (const person of roster) {
    if (onVisit.has(person.id)) {
      results.push({ id: person.id, status: 'already on visit' });
      continue;
    }
    const shift = await sas(
      'POST',
      '/team-scheduling/shifts/',
      shiftBody(visit.id, cycle.id, person.id, person.lead, opts.shiftStart, opts.shiftEnd),
      cycle.id
    );
    results.push({
      id: person.id,
      name: shift.employee?.person?.person_name,
      lead: person.lead,
      shiftId: shift.id,
      status: 'created',
    });
    console.log(
      `+ ${shift.employee?.person?.person_name || person.id} shift ${shift.id}${person.lead ? ' (lead)' : ''}`
    );
  }

  const verify = rows(
    await sas('GET', `/team-scheduling/shifts/?page=1&page_size=50&visit=${visit.id}`, null, cycle.id)
  ).filter((s) => s.current_status === 'active');
  const rosterShifts = verify.filter((s) =>
    roster.some((p) => p.id === Number(s.employee?.id ?? s.employee))
  );

  console.log(
    JSON.stringify(
      {
        visitId: visit.id,
        store: getVisitStoreNumber(visit),
        rosterCount: rosterShifts.length,
        lead: rosterShifts.find((s) => s.is_lead === true || s.is_lead === 'true')?.employee
          ?.person?.person_name,
        mileageOff: rosterShifts.every(
          (s) =>
            !s.calculate_mileage &&
            !s.home_to_store &&
            !s.store_to_home &&
            !s.store_to_store
        ),
        results,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
