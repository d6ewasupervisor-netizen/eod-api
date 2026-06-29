#!/usr/bin/env node
'use strict';

/**
 * Copy an entire active roster from a source visit to a destination date
 * (same Kompass project/cycle week, same store, same team + lead).
 *
 * Usage:
 *   node copy-roster-to-date.js --store 462 --source-date 2026-06-25 --dest-date 2026-06-26 --dry-run
 *   node copy-roster-to-date.js --store 462 --project 1 --start-offset-minutes 3
 *
 * Auth: sas-auth/.sas-session/auth-state.json (see sas-auth-prod-session skill)
 */

const fs = require('fs');
const {
  filterVisitsByStore,
  assertVisitStore,
  getVisitStoreNumber,
} = require('./sas-store-match');
const {
  buildVisitCreateBody,
  teamSchedulingReferer,
} = require('./sas-visit-create');

const DEFAULT_STATE = 'C:/Users/tgaut/sas-auth/.sas-session/auth-state.json';
const BASE = 'https://prod.sasretail.com/api/v1';
const DEFAULT_PROJECT = 1;

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    projectId: DEFAULT_PROJECT,
    startOffsetMinutes: 3,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--store') opts.storeNumber = argv[++i];
    else if (arg === '--source-date') opts.sourceDate = argv[++i];
    else if (arg === '--dest-date') opts.destDate = argv[++i];
    else if (arg === '--project') opts.projectId = Number(argv[++i]);
    else if (arg === '--cycle-name') opts.cycleName = argv[++i];
    else if (arg === '--source-visit-id') opts.sourceVisitId = Number(argv[++i]);
    else if (arg === '--start-offset-minutes') opts.startOffsetMinutes = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') opts.help = true;
  }
  return opts;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function tomorrowIso() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function usage() {
  console.log(`Usage:
  node copy-roster-to-date.js --store N [--source-date YYYY-MM-DD] [--dest-date YYYY-MM-DD] \\
    [--project 1] [--cycle-name P6W1] [--start-offset-minutes 3] [--source-visit-id ID] [--dry-run]

Defaults: source-date=today, dest-date=tomorrow, project=1 (Fred Meyer Kompass ISE).
Default start-offset-minutes=3 avoids "Team already have scheduled Visit at this time!" when
copying the same team to the next day at the same clock time.

Creates the destination visit when none exists, then POSTs each active source shift.
Terminated/inactive employees on the source roster are skipped with a reason.`);
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

function rows(data) {
  return Array.isArray(data) ? data : data?.results || [];
}

function isLead(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
}

function empId(shift) {
  return shift.employee?.id ?? shift.employee;
}

function empName(shiftOrEmp) {
  const e = shiftOrEmp.employee || shiftOrEmp;
  return e.person?.person_name || e.person_name || '';
}

function terminationNote(shift) {
  const term = shift.employee?.termination_date;
  return term ? `terminated ${term}` : 'not active for new scheduling';
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help || !opts.storeNumber) {
    usage();
    process.exit(opts.help ? 0 : 1);
  }

  const sourceDate = opts.sourceDate || todayIso();
  const destDate = opts.destDate || tomorrowIso();
  const session = loadSession();

  async function sas(method, apiPath, body, cycleId) {
    const headers = {
      Accept: 'application/json',
      Authorization: `Token ${session.token}`,
      'X-Requested-With': 'XMLHttpRequest',
    };
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      if (session.csrf) headers['X-CSRFToken'] = session.csrf;
      if (session.cookieHeader) headers.Cookie = session.cookieHeader;
      if (cycleId) headers.Referer = teamSchedulingReferer(cycleId);
    }
    const res = await fetch(BASE + apiPath, {
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

  async function resolveCycle(projectId, dateIso) {
    const cycles = rows(
      await sas(
        'GET',
        `/projects/project-cycles/?current_status=active&page=1&page_size=100&project=${projectId}&sort=start_date`
      )
    );
    let cycle = cycles.find(
      (c) => String(c.start_date || '') <= dateIso && String(c.end_date || '') >= dateIso
    );
    if (opts.cycleName) {
      const needle = String(opts.cycleName).toLowerCase();
      const named = cycles.find(
        (c) =>
          String(c.start_date || '') <= dateIso &&
          String(c.end_date || '') >= dateIso &&
          String(c.name || '').toLowerCase().includes(needle)
      );
      if (named) cycle = named;
    }
    if (!cycle) throw new Error(`No active cycle for project ${projectId} covering ${dateIso}`);
    return cycle;
  }

  async function findVisit(cycleId, dateIso, storeNumber) {
    const visits = rows(
      await sas('GET', `/team-scheduling/visits/?cycle=${cycleId}&page=1&page_size=500`)
    );
    const matches = filterVisitsByStore(
      visits.filter((v) => String(v.scheduled_date) === dateIso),
      storeNumber
    );
    return matches;
  }

  const cycle = await resolveCycle(opts.projectId, destDate);
  console.log(`Cycle: ${cycle.id} ${cycle.name} (${cycle.start_date} - ${cycle.end_date})`);
  console.log(`Store (exact): ${opts.storeNumber}`);
  console.log(`Source date: ${sourceDate} -> Dest date: ${destDate}`);
  console.log(`Start offset: +${opts.startOffsetMinutes} min`);
  if (opts.dryRun) console.log('Mode: dry-run (no mutations)');

  let sourceVisit;
  if (opts.sourceVisitId) {
    sourceVisit = await sas('GET', `/team-scheduling/visits/${opts.sourceVisitId}/`);
    assertVisitStore(sourceVisit, opts.storeNumber, 'Source visit');
    if (String(sourceVisit.scheduled_date) !== sourceDate) {
      console.warn(
        `Warning: source visit ${opts.sourceVisitId} scheduled_date is ${sourceVisit.scheduled_date}, not ${sourceDate}`
      );
    }
  } else {
    const sourceMatches = await findVisit(cycle.id, sourceDate, opts.storeNumber);
    if (sourceMatches.length !== 1) {
      throw new Error(
        `Expected one source visit for store ${opts.storeNumber} on ${sourceDate}, found ${sourceMatches.length}`
      );
    }
    sourceVisit = await sas('GET', `/team-scheduling/visits/${sourceMatches[0].id}/`);
    assertVisitStore(sourceVisit, opts.storeNumber, 'Source visit');
  }

  const sourceShifts = rows(
    await sas('GET', `/team-scheduling/shifts/?page=1&page_size=50&visit=${sourceVisit.id}`)
  ).filter((s) => s.current_status === 'active');

  console.log(`Source visit ${sourceVisit.id} | team ${sourceVisit.team?.name} | roster ${sourceShifts.length}`);
  for (const s of sourceShifts) {
    console.log(`  - ${empName(s)}${isLead(s.is_lead) ? ' (lead)' : ''}`);
  }

  const destMatches = await findVisit(cycle.id, destDate, opts.storeNumber);
  let destVisitId = destMatches.length === 1 ? destMatches[0].id : null;
  const visitBody = buildVisitCreateBody(sourceVisit, destDate, {
    startOffsetMinutes: opts.startOffsetMinutes,
  });

  console.log(`Planned dest visit: ${JSON.stringify(visitBody, null, 2)}`);

  if (destMatches.length > 1) {
    throw new Error(
      `Expected at most one dest visit for store ${opts.storeNumber} on ${destDate}, found ${destMatches.length}`
    );
  }

  if (opts.dryRun) {
    console.log(destVisitId ? `Would reuse dest visit ${destVisitId}` : 'Would create new dest visit');
    return;
  }

  let destVisit;
  if (destVisitId) {
    destVisit = await sas('GET', `/team-scheduling/visits/${destVisitId}/`);
    console.log(`Reusing existing dest visit ${destVisitId}`);
  } else {
    destVisit = await sas('POST', '/team-scheduling/visits/', visitBody, cycle.id);
    destVisitId = destVisit.id;
    destVisit = await sas('GET', `/team-scheduling/visits/${destVisitId}/`);
    console.log(`Created dest visit ${destVisitId}`);
  }

  assertVisitStore(destVisit, opts.storeNumber, 'Destination visit');

  const existingShifts = rows(
    await sas('GET', `/team-scheduling/shifts/?page=1&page_size=50&visit=${destVisitId}`)
  ).filter((s) => s.current_status === 'active');
  const existingIds = new Set(existingShifts.map((s) => Number(empId(s))));

  const added = [];
  const skipped = [];
  const failed = [];

  const ordered = [...sourceShifts].sort(
    (a, b) => (isLead(b.is_lead) ? 1 : 0) - (isLead(a.is_lead) ? 1 : 0)
  );

  for (const s of ordered) {
    const id = Number(empId(s));
    const name = empName(s);
    if (existingIds.has(id)) {
      skipped.push({ name, reason: 'already on dest visit' });
      continue;
    }
    try {
      const created = await sas(
        'POST',
        '/team-scheduling/shifts/',
        {
          home_to_store: true,
          store_to_store: true,
          store_to_home: true,
          calculate_mileage: true,
          visit: String(destVisitId),
          employee: id,
          cycle: Number(destVisit.cycle),
          shift_start_time: destVisit.shift_start_time,
          shift_end_time: destVisit.shift_end_time,
          current_status: 'active',
          rate_type: {},
          device_reimbursement: false,
          is_lead: isLead(s.is_lead) ? 'true' : 'false',
        },
        cycle.id
      );
      added.push({ name, lead: isLead(s.is_lead), shiftId: created.id });
      existingIds.add(id);
    } catch (err) {
      failed.push({ name, employeeId: id, reason: err.message, note: terminationNote(s) });
    }
  }

  const finalShifts = rows(
    await sas('GET', `/team-scheduling/shifts/?page=1&page_size=50&visit=${destVisitId}`)
  ).filter((s) => s.current_status === 'active');

  const summary = {
    sourceVisitId: sourceVisit.id,
    destVisitId,
    store: getVisitStoreNumber(destVisit),
    destDate,
    team: destVisit.team?.name,
    times: `${destVisit.shift_start_time} - ${destVisit.shift_end_time}`,
    added,
    skipped,
    failed,
    finalRoster: finalShifts.map((s) => ({
      name: empName(s),
      lead: isLead(s.is_lead),
      shiftId: s.id,
    })),
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
